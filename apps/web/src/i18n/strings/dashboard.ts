/** Dashboard page + mesh topology. */
const en = {
  // Page hero.
  title: 'Overview',
  subtitle: 'Upstream MCP servers aggregated into one connection for your agent tools.',
  // Summary cards.
  servers: 'MCP servers',
  serversHint: 'Upstream connections (SSE · HTTP)',
  profiles: 'Profiles',
  profilesHint: 'Bundles of servers for agent tools',
  credentials: 'Credentials',
  credentialsHint: 'Encrypted secrets for upstreams',
  users: 'Users',
  usersHint: 'Accounts and roles',
  settings: 'Settings',
  settingsHint: 'Registration switch',
  manage: 'Manage',
  open: 'Open',
  // Count suffix inside SummaryLink (plural picked by count).
  itemsOne: 'item',
  itemsMany: 'items',
  // Non-admin account card.
  account: 'Account',
  accountDesc: 'Your profile and access level',
  username: 'Username',
  email: 'Email',
  // Toast + footer.
  loadFailed: 'Failed to load overview',
  footerPrefix: 'Agent tools connect via a PAT and a profile:',
  footerSuffix:
    '. callable-function scripts (wrapping vendor APIs as MCP tools) arrive in a later phase.',
  // Mesh topology.
  loadingMesh: 'Loading your mesh…',
  noServers: 'No upstream servers yet',
  noServersHint: 'Add an MCP server to start shaping your mesh.',
  addConnection: 'Add connection',
  yourMesh: 'Your mesh',
  upOne: '{count} upstream',
  upMany: '{count} upstreams',
  legendConnected: 'connected',
  legendError: 'error',
  legendConfigured: 'configured',
  meshAria: 'Mesh of {count} configured upstream MCP servers converging on Harness Nexus.',
  moreCount: '+{count} more',
  tools: 'tools',
};

const zh: typeof en = {
  // Page hero.
  title: '总览',
  subtitle: '将上游 MCP 服务器聚合为一个连接，供你的 Agent 工具使用。',
  // Summary cards.
  servers: 'MCP 服务器',
  serversHint: '上游连接（SSE · HTTP）',
  profiles: '配置集',
  profilesHint: '供 Agent 工具使用的服务器集合',
  credentials: '凭据',
  credentialsHint: '上游的加密密钥',
  users: '用户',
  usersHint: '账户与角色',
  settings: '设置',
  settingsHint: '注册开关',
  manage: '管理',
  open: '打开',
  // Count suffix inside SummaryLink (plural picked by count).
  itemsOne: '项',
  itemsMany: '项',
  // Non-admin account card.
  account: '账户',
  accountDesc: '你的个人资料与访问级别',
  username: '用户名',
  email: '邮箱',
  // Toast + footer.
  loadFailed: '加载总览失败',
  footerPrefix: 'Agent 工具通过访问令牌（PAT）和配置集连接：',
  footerSuffix: '。callable-function 脚本（将厂商 API 封装为 MCP 工具）将在后续阶段推出。',
  // Mesh topology.
  loadingMesh: '正在加载你的网格…',
  noServers: '还没有上游服务器',
  noServersHint: '添加一个 MCP 服务器，开始构建你的网格。',
  addConnection: '添加连接',
  yourMesh: '你的网格',
  upOne: '{count} 个上游',
  upMany: '{count} 个上游',
  legendConnected: '已连接',
  legendError: '错误',
  legendConfigured: '已配置',
  meshAria: '{count} 个已配置的上游 MCP 服务器汇聚到 Harness Nexus 的网格。',
  moreCount: '+{count} 更多',
  tools: '工具',
};

export const dashboardStrings = { en, zh };
