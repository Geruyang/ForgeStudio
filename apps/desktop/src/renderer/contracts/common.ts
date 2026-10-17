﻿﻿﻿/**
 * 契约子路径入口（renderer 本地转发）：
 * vite.config.ts 的 '@forgedesk/contracts' 字符串别名会做前缀替换，
 * 无法承载子路径；此处用相对路径直达 contracts 源码（与别名同源），
 * 供 tsc / vite / vitest 一致解析。冻结契约只读引用。
 */
export * from '../../../../../packages/contracts/src/common';
