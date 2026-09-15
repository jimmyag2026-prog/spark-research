/// <reference types="vite/client" />

// 构建期注入（vite.config.ts 的 `define`）：构建这份 UI 时仓库根 package.json 的版本号。
// U2 的「server vX ≠ UI vY」徽标要拿它和 `/api/health.version` 比——两天没被发现的
// 版本困惑，直接原因就是界面上看不到这两个数。
declare const __SPARK_UI_VERSION__: string;
