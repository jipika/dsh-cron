// dsh-cron — browser half（第一步：让 client 包能 compose 通过，UI 随后接入）
//
// 形态照 ~/.dsh/local-plugins/dsh-todo-float/lib/client.js：
//   `window.__ModuleLoader__.load({ id, factory })`，factory 里 return 一个
//   `{ name, inject, apply }`。`require` 能解析的只有几个 seed：
//   react / react-dom / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives。
window.__ModuleLoader__.load({
	id: '@jipika/dsh-cron',
	factory: (require) => {
		const React = require('react')

		// 占位组件：UI 面板接入前先保证模块结构成立。
		function CronPlaceholder() {
			return null
		}

		return {
			name: 'dsh-cron',
			inject: ['slots'],
			apply(ctx) {
				console.log('[dsh-cron] client half mounted')
				void React
				void CronPlaceholder
				void ctx
			},
		}
	},
})
