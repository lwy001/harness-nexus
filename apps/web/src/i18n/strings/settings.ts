/** Admin system settings page. */
const en = {
  title: 'System settings',
  subtitle: 'Instance-wide configuration.',
  registration: 'Registration',
  registrationDesc:
    'When enabled, anyone can create an account. When disabled, only admins can add users.',
  allowPublicRegistration: 'Allow public registration',
  currentState: 'Current state:',
  open: 'Open',
  closed: 'Closed',
  registrationOpened: 'Registration opened',
  registrationClosed: 'Registration closed',
  prewarm: 'Adapter pre-warm',
  prewarmDesc:
    'Keep one adapter process per target warmed up while a chat session page is open, so clicking a session skips the adapter boot.',
  prewarmHint:
    'Off by default for claude-code and codex (small gain, one idle process each); deepseek gains the most (~1.3s per open).',
  prewarmUpdated: 'Pre-warm settings saved',
};

const zh: typeof en = {
  title: '系统设置',
  subtitle: '实例级配置。',
  registration: '注册',
  registrationDesc: '开启后，任何人都可以创建账户；关闭后，只有管理员能添加用户。',
  allowPublicRegistration: '允许公开注册',
  currentState: '当前状态：',
  open: '开放',
  closed: '关闭',
  registrationOpened: '已开放注册',
  registrationClosed: '已关闭注册',
  prewarm: '适配器预连接',
  prewarmDesc:
    '会话页面打开期间，为每个目标常备一个预热好的适配器进程，点击会话时跳过适配器启动。',
  prewarmHint:
    'claude-code 与 codex 默认关闭（收益较小，各占一个空闲进程）；deepseek 收益最大（每次打开约省 1.3 秒）。',
  prewarmUpdated: '预连接设置已保存',
};

export const settingsStrings = { en, zh };
