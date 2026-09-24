// dsh-cron — node half（宿主半边）
//
// 目标：DSH 原生的"定时任务"——到点在**全新会话**里跑一条保存好的 prompt，
// 任务表持久化在磁盘，管理界面在 Web 侧（./client.js）。
//
// 设计取舍（都基于本机实测结论）：
//   · 路由用 `ctx.webServer.register({kind:'prefix', ...})`，**绝不用
//     `ctx.connection.rpc.handle()`** —— 后者在 core 0.1.5-rc.2 上会抛
//     `cannot get property "webServer" without inject` 且补 inject 也无效。
//   · 持久化用「一个 JSON 文件 + 原子替换」，不依赖任何 npm 包；
//     另外**不 import 任何裸包名**（link: 插件解析不到 profile 的 node_modules，
//     dsh-skill-mcp-panel 就是栽在 `import 'zod'` 上）。
//   · 调度用 30s ticker + 每分钟计算下一次触发时刻，任务表里不持久化
//     nextRun，避免时钟漂移与停机造成的漂移累积。
//
// 状态文件：`~/.dsh/dsh-cron/tasks.json`

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-cron'

// 只要这些服务就够；刻意**不**声明 connection（避免踩上面那个坑）。
export const inject = ['webServer', 'agents', 'sessions', 'workspaceRegistry', 'agentDefaultModel', 'permissionPresets', 'approval']

const STATE_DIR = join(homedir(), '.dsh', 'dsh-cron')
const STATE_FILE = join(STATE_DIR, 'tasks.json')
const TICK_MS = 30_000
const MIN_EVERY_MINUTES = 5
const HISTORY_LIMIT = 20
const MAX_PROMPT_CHARS = 20_000

// ────────────────────────────── 持久化 ──────────────────────────────

function emptyState() {
	return { version: 1, tasks: [] }
}

function loadState() {
	try {
		if (!existsSync(STATE_FILE)) return emptyState()
		const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
		if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) return emptyState()
		return { version: 1, tasks: parsed.tasks.filter((t) => t && typeof t === 'object') }
	} catch {
		return emptyState()
	}
}

function saveState(state) {
	mkdirSync(STATE_DIR, { recursive: true })
	const tmp = `${STATE_FILE}.${process.pid}.tmp`
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
	renameSync(tmp, STATE_FILE)
}

// ────────────────────────────── 计划计算 ──────────────────────────────

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 解析 "HH:MM" → {hours, minutes}；非法返回 null。 */
function parseClock(text) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
	if (!m) return null
	const hours = Number(m[1])
	const minutes = Number(m[2])
	if (hours > 23 || minutes > 59) return null
	return { hours, minutes }
}

/**
 * 校验并规范化 schedule。
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function normalizeSchedule(raw) {
	if (raw === null || typeof raw !== 'object') return { ok: false, error: 'schedule 必须是对象' }
	const kind = raw.kind
	if (kind === 'once') {
		const at = new Date(String(raw.at ?? ''))
		if (Number.isNaN(at.getTime())) return { ok: false, error: 'at 必须是可解析的时间（RFC3339）' }
		return { ok: true, value: { kind: 'once', at: at.toISOString() } }
	}
	if (kind === 'every') {
		const minutes = Number(raw.minutes)
		if (!Number.isFinite(minutes) || minutes < MIN_EVERY_MINUTES) {
			return { ok: false, error: `every.minutes 必须是不小于 ${MIN_EVERY_MINUTES} 的数字` }
		}
		return { ok: true, value: { kind: 'every', minutes: Math.round(minutes) } }
	}
	if (kind === 'daily') {
		const clock = parseClock(raw.time)
		if (!clock) return { ok: false, error: 'daily.time 必须是 HH:MM' }
		return { ok: true, value: { kind: 'daily', time: `${String(clock.hours).padStart(2, '0')}:${String(clock.minutes).padStart(2, '0')}` } }
	}
	if (kind === 'weekly') {
		const clock = parseClock(raw.time)
		if (!clock) return { ok: false, error: 'weekly.time 必须是 HH:MM' }
		const days = Array.isArray(raw.days) ? [...new Set(raw.days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : []
		if (days.length === 0) return { ok: false, error: 'weekly.days 至少给一个 0-6 的星期（0=周日）' }
		return {
			ok: true,
			value: { kind: 'weekly', time: `${String(clock.hours).padStart(2, '0')}:${String(clock.minutes).padStart(2, '0')}`, days: days.sort((a, b) => a - b) },
		}
	}
	return { ok: false, error: 'schedule.kind 必须是 once / every / daily / weekly' }
}

/** 人类可读的计划描述（给 UI 与列表用）。 */
export function describeSchedule(s) {
	if (!s) return '(无计划)'
	if (s.kind === 'once') return `一次性 · ${new Date(s.at).toLocaleString('zh-CN', { hour12: false })}`
	if (s.kind === 'every') return `每 ${s.minutes} 分钟`
	if (s.kind === 'daily') return `每天 ${s.time}`
	if (s.kind === 'weekly') return `每${s.days.map((d) => WEEKDAY_NAMES[d]).join('、')} ${s.time}`
	return '(未知计划)'
}

function lastRunAt(task) {
	const runs = Array.isArray(task.runs) ? task.runs : []
	const done = runs.filter((r) => r && r.status !== 'running' && r.at)
	if (done.length === 0) return null
	return new Date(done[0].at)
}

/**
 * 计算任务在 `from` 之后的下一次触发时刻；无下次（已跑完的一次性任务）返回 null。
 */
export function nextRunFor(task, from = new Date()) {
	const s = task.schedule
	if (!s) return null
	if (s.kind === 'once') {
		const at = new Date(s.at)
		if (Number.isNaN(at.getTime())) return null
		// 一次性任务：跑过一次就永不再触发。
		const ran = (task.runs ?? []).some((r) => r && r.status !== 'running')
		if (ran && at <= from) return null
		return at
	}
	if (s.kind === 'every') {
		const last = lastRunAt(task)
		if (!last) {
			// 尚未跑过：按"从现在起一个间隔"算，避免装载即触发。
			return new Date(from.getTime() + s.minutes * 60_000)
		}
		const next = new Date(last.getTime() + s.minutes * 60_000)
		return next <= from ? new Date(from.getTime() + 1000) : next
	}
	const clock = parseClock(s.time)
	if (!clock) return null
	if (s.kind === 'daily') {
		const candidate = new Date(from)
		candidate.setHours(clock.hours, clock.minutes, 0, 0)
		if (candidate <= from) candidate.setDate(candidate.getDate() + 1)
		return candidate
	}
	// weekly
	for (let offset = 0; offset < 8; offset += 1) {
		const candidate = new Date(from)
		candidate.setDate(candidate.getDate() + offset)
		candidate.setHours(clock.hours, clock.minutes, 0, 0)
		if (candidate <= from) continue
		if (s.days.includes(candidate.getDay())) return candidate
	}
	return null
}

// ────────────────────────────── 任务表操作 ──────────────────────────────

function newId() {
	return `cron-${randomUUID().slice(0, 8)}`
}

function taskView(task, now) {
	const next = nextRunFor(task, now)
	return {
		id: task.id,
		name: task.name,
		prompt: task.prompt,
		schedule: task.schedule,
		scheduleText: describeSchedule(task.schedule),
		cwd: task.cwd,
		permission: task.permission,
		enabled: task.enabled !== false,
		createdAt: task.createdAt,
		nextRunAt: task.enabled === false ? null : next ? next.toISOString() : null,
		runCount: Array.isArray(task.runs) ? task.runs.length : 0,
		runs: (task.runs ?? []).slice(0, HISTORY_LIMIT),
	}
}

function stateView(state) {
	const now = new Date()
	return {
		ok: true,
		config: { tickMs: TICK_MS, minEveryMinutes: MIN_EVERY_MINUTES, historyLimit: HISTORY_LIMIT, stateFile: STATE_FILE },
		now: now.toISOString(),
		tasks: state.tasks.map((t) => taskView(t, now)),
	}
}

// ────────────────────────────── 执行器 ──────────────────────────────

/**
 * 在**全新的根 agent + 新会话**里执行一条任务。
 * 由 apply() 里的 `wireExecutor` 注入；未接线时抛错，ticker 会把它记成 failed。
 * @returns {Promise<{sessionId?: string, summary?: string}>}
 */
let executeTask = null

/** 深冻结：等价 dsh-llm 的 deepFreeze(structuredClone(x))，零依赖。 */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value)
		for (const key of Object.keys(value)) deepFreeze(value[key])
	}
	return value
}

/** 造一条 user 消息：等价 createUserMessage({content, source})。 */
function userMessage(text) {
	return deepFreeze({
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text }],
		source: { kind: 'user' },
	})
}

/** 定时任务专用 preset id：见 ~/.dsh/.agent-presets/cron（干净人格 + 单 shell）。
 *  注意：**不要**从 ctx.agentPresets.composedPreset(ctx) 取 —— 那是宿主插件自己的
 *  部署默认（standard），会把 cron 顶掉，实测任务于是带着 cua/browser 全套工具跑偏。 */
function presetIdOf() {
	return 'cron'
}

function createExecutor(ctx, logger) {
	return async function execute(task) {
		const selection = (() => {
			try {
				return ctx.agentDefaultModel?.currentSelection?.() ?? {}
			} catch {
				return {}
			}
		})()
		const sessionId = `cron-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 6)}`
		const agentOptions = {}
		if (typeof selection.provider === 'string') agentOptions.provider = selection.provider
		if (typeof selection.model === 'string') agentOptions.model = selection.model

		const handle = await ctx.agents.create({
			sessionId,
			meta: { cwd: task.cwd, agentPreset: presetIdOf(ctx) },
			...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
		})
		const agent = handle.agent
		await agent.whenIdle()

		// 先把权限档位与非可见性定好，再让它跑
		try {
			ctx.permissionPresets.set(agent.session, task.permission)
		} catch (error) {
			logger.warn('设置权限档位失败：%s', error instanceof Error ? error.message : String(error))
		}
		// 无人值守：沙箱档位按任务声明，审批一律 never（顺序必须在 permissionPresets 之后，
		// 因为 workspace-write / read-only 档位本身带 approval: ask —— 实测会让任务卡住）。
		try {
			ctx.approval.setPolicy(agent, 'never')
		} catch (error) {
			logger.warn('取消审批失败：%s', error instanceof Error ? error.message : String(error))
		}
		try {
			const workspace = await ctx.workspaceRegistry.create(task.cwd)
			await workspace.attachSession(sessionId)
		} catch (error) {
			logger.warn('挂到工作区失败（会落到未分组）：%s', error instanceof Error ? error.message : String(error))
		}

		const boundary = agent.session.seq
		agent.followup(userMessage(task.prompt))
		await agent.whenIdle()
		await ctx.sessions.flush(agent.session)

		const texts = []
		for (const event of agent.session.snapshotEvents(boundary)) {
			if (event.type !== 'assistant/message') continue
			for (const block of event.data?.message?.content ?? []) {
				if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
			}
		}
		const summary = texts.join('\n').trim()
		return { sessionId, summary: summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary }
	}
}

/** 记录一次运行结果（写进任务的 runs 头部，并裁剪到 HISTORY_LIMIT）。 */
function recordRun(task, run) {
	if (!Array.isArray(task.runs)) task.runs = []
	task.runs.unshift(run)
	if (task.runs.length > HISTORY_LIMIT) task.runs.length = HISTORY_LIMIT
}

// ────────────────────────────── REST 面 ──────────────────────────────

function reply(res, status, body) {
	const payload = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
	})
	res.end(payload)
}

/** 只接受同源（本机 GUI / curl）请求，挡掉跨站伪造。 */
function isTrustedRequest(req) {
	const origin = req.headers.origin
	if (typeof origin === 'string' && origin !== '') {
		try {
			const host = new URL(origin).hostname
			if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return false
		} catch {
			return false
		}
	}
	const site = req.headers['sec-fetch-site']
	if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') return false
	return true
}

function readBody(req, limit = 256 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > limit) {
				reject(new Error('请求体过大'))
				req.destroy()
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim()
			if (text === '') return resolve({})
			try {
				const parsed = JSON.parse(text)
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(new Error('请求体必须是 JSON 对象'))
				resolve(parsed)
			} catch {
				reject(new Error('请求体不是合法 JSON'))
			}
		})
		req.on('error', reject)
	})
}

function normalizeCreate(body, state) {
	const name = String(body.name ?? '').trim()
	if (name === '') return { ok: false, error: 'name 不能为空' }
	const prompt = String(body.prompt ?? '').trim()
	if (prompt === '') return { ok: false, error: 'prompt 不能为空' }
	if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: `prompt 太长（上限 ${MAX_PROMPT_CHARS} 字符）` }
	const schedule = normalizeSchedule(body.schedule)
	if (!schedule.ok) return { ok: false, error: schedule.error }
	const cwd = String(body.cwd ?? '').trim() || homedir()
	const permission = ['read-only', 'workspace-write', 'danger-full-access'].includes(body.permission) ? body.permission : 'workspace-write'
	const task = {
		id: newId(),
		name,
		prompt,
		schedule: schedule.value,
		cwd,
		permission,
		enabled: body.enabled !== false,
		createdAt: new Date().toISOString(),
		runs: [],
	}
	state.tasks.push(task)
	return { ok: true, task }
}

function applyPatch(task, body) {
	if (typeof body.name === 'string' && body.name.trim() !== '') task.name = body.name.trim()
	if (typeof body.prompt === 'string' && body.prompt.trim() !== '') task.prompt = body.prompt.trim()
	if (typeof body.cwd === 'string' && body.cwd.trim() !== '') task.cwd = body.cwd.trim()
	if (['read-only', 'workspace-write', 'danger-full-access'].includes(body.permission)) task.permission = body.permission
	if (typeof body.enabled === 'boolean') task.enabled = body.enabled
	if (body.schedule !== undefined) {
		const s = normalizeSchedule(body.schedule)
		if (!s.ok) return { ok: false, error: s.error }
		task.schedule = s.value
		// 计划变了：历史保留，但一次性任务允许重新武装。
		if (s.value.kind === 'once') task.enabled = body.enabled !== false
	}
	return { ok: true }
}

// ────────────────────────────── 插件主体 ──────────────────────────────

export function apply(ctx) {
	const logger = ctx.logger('dsh-cron')
	const state = loadState()
	let timer = null
	let running = false

	const persist = () => saveState(state)
	executeTask = createExecutor(ctx, logger)

	async function fire(task, reason) {
		const startedAt = new Date().toISOString()
		const run = { at: startedAt, status: 'running', trigger: reason }
		recordRun(task, run)
		persist()
		if (executeTask === null) {
			run.status = 'failed'
			run.error = '执行器未接线（等 agents.create 路径确认）'
			run.finishedAt = new Date().toISOString()
			persist()
			logger.warn('任务 %s 触发，但执行器未接线', task.id)
			return
		}
		try {
			const result = await executeTask(task)
			run.status = 'ok'
			run.finishedAt = new Date().toISOString()
			if (result?.sessionId !== undefined) run.sessionId = result.sessionId
			if (result?.summary !== undefined) run.summary = result.summary
			logger.info('任务 %s 执行完成（session %s）', task.id, result?.sessionId ?? '?')
		} catch (error) {
			run.status = 'failed'
			run.finishedAt = new Date().toISOString()
			run.error = error instanceof Error ? error.message : String(error)
			logger.warn('任务 %s 执行失败：%s', task.id, run.error)
		}
		if (task.schedule?.kind === 'once') task.enabled = false
		persist()
	}

	async function tick() {
		if (running) return
		running = true
		try {
			const now = new Date()
			for (const task of state.tasks) {
				if (task.enabled === false) continue
				const next = nextRunFor(task, now)
				if (!next || next > now) continue
				const inFlight = (task.runs ?? []).some((r) => r && r.status === 'running')
				if (inFlight) continue
				await fire(task, 'schedule')
			}
		} catch (error) {
			logger.warn('tick 失败：%s', error instanceof Error ? error.message : String(error))
		} finally {
			running = false
		}
	}

	// ── 路由 ──
	const handler = (req, res) => {
		void (async () => {
			try {
				if (!isTrustedRequest(req)) {
					reply(res, 403, { ok: false, error: '请求来源不受信任' })
					return
				}
				const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
				const method = req.method ?? 'GET'

				if (path === '/dsh-cron/health' && method === 'GET') {
					reply(res, 200, { ok: true, service: 'dsh-cron', time: Date.now(), tasks: state.tasks.length })
					return
				}
				if (path === '/dsh-cron/state' && method === 'GET') {
					reply(res, 200, stateView(state))
					return
				}
				if (path === '/dsh-cron/tasks' && method === 'POST') {
					const body = await readBody(req)
					const created = normalizeCreate(body, state)
					if (!created.ok) {
						reply(res, 400, { ok: false, error: created.error })
						return
					}
					persist()
					reply(res, 200, { ok: true, task: taskView(created.task, new Date()) })
					return
				}
				const match = /^\/dsh-cron\/tasks\/([^/]+)(?:\/(run|clear-history))?$/.exec(path)
				if (match) {
					const id = decodeURIComponent(match[1])
					const action = match[2]
					const task = state.tasks.find((t) => t.id === id)
					if (!task) {
						reply(res, 404, { ok: false, error: `找不到任务 ${id}` })
						return
					}
					if (action === undefined && method === 'PATCH') {
						const patched = applyPatch(task, await readBody(req))
						if (!patched.ok) {
							reply(res, 400, { ok: false, error: patched.error })
							return
						}
						persist()
						reply(res, 200, { ok: true, task: taskView(task, new Date()) })
						return
					}
					if (action === undefined && method === 'DELETE') {
						state.tasks = state.tasks.filter((t) => t.id !== id)
						persist()
						reply(res, 200, { ok: true })
						return
					}
					if (action === 'run' && method === 'POST') {
						void fire(task, 'manual')
						reply(res, 200, { ok: true, task: taskView(task, new Date()) })
						return
					}
					if (action === 'clear-history' && method === 'POST') {
						task.runs = []
						persist()
						reply(res, 200, { ok: true, task: taskView(task, new Date()) })
						return
					}
					reply(res, 405, { ok: false, error: `${method} 不被支持` })
					return
				}
				reply(res, 404, { ok: false, error: `未知路由 ${method} ${path}` })
			} catch (error) {
				logger.warn('请求失败：%s', error instanceof Error ? error.message : String(error))
				reply(res, 500, { ok: false, error: error instanceof Error ? error.message : '内部错误' })
			}
		})()
	}

	const disposeRoute = ctx.webServer.register({ kind: 'prefix', path: '/dsh-cron', handler })

	// ── 调度器 ──
	timer = setInterval(() => void tick(), TICK_MS)
	// 启动后 5s 做一次补跑（应用刚起来时可能已过期）
	const kick = setTimeout(() => void tick(), 5_000)

	// 正常路径下由 cordis effect 回收；宿主退出时进程结束即止。
	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => {
			clearInterval(timer)
			clearTimeout(kick)
			disposeRoute?.()
		})
	}

	logger.info('host half mounted（%d 个任务，状态文件 %s）', state.tasks.length, STATE_FILE)
	void tick()
}
