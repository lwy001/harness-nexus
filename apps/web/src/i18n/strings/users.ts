/** Admin users page. */
const en = {
  title: 'Users',
  subtitle: 'Manage accounts and roles.',
  countOne: '{count} user',
  countMany: '{count} users',
  username: 'Username',
  role: 'Role',
  created: 'Created',
  loadFailed: 'Failed to load users',
  noUsers: 'No users yet.',
  nowRole: '{username} is now {role}',
  deleted: 'Deleted {username}',
  confirmDelete: 'Delete user {username}? This cannot be undone.',
  makeAdmin: 'Make admin',
  makeUser: 'Make user',
  // Create form.
  addUser: 'Add user',
  addUserDesc: 'Bypasses the registration switch — admins can always add users.',
  password: 'Password',
  createdOk: 'Created {username}',
};

const zh: typeof en = {
  title: '用户',
  subtitle: '管理账户与角色。',
  countOne: '{count} 个用户',
  countMany: '{count} 个用户',
  username: '用户名',
  role: '角色',
  created: '创建时间',
  loadFailed: '加载用户失败',
  noUsers: '还没有用户。',
  nowRole: '{username} 已变更为 {role}',
  deleted: '已删除 {username}',
  confirmDelete: '确定删除用户 {username} 吗？此操作不可撤销。',
  makeAdmin: '设为管理员',
  makeUser: '设为用户',
  addUser: '添加用户',
  addUserDesc: '此入口不受注册开关限制——管理员随时可以添加用户。',
  password: '密码',
  createdOk: '已创建 {username}',
};

export const usersStrings = { en, zh };
