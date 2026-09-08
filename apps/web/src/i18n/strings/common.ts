/**
 * Strings shared across pages: table chrome, action buttons, scope/role
 * vocabulary, and the generic toast fallbacks. Pages import these via
 * `t('common.xxx')` instead of re-declaring their own copies.
 */
const en = {
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  delete: 'Delete',
  remove: 'Remove',
  edit: 'Edit',
  create: 'Create',
  close: 'Close',
  done: 'Done',
  copy: 'Copy',
  copied: 'Copied',
  openMenu: 'Open menu',
  actions: 'Actions',
  name: 'Name',
  description: 'Description',
  status: 'Status',
  loading: 'Loading…',
  // Scope vocabulary (rendered from `scope` values on records).
  scope: 'Scope',
  scopeGlobal: 'global',
  scopePersonal: 'personal',
  // Role vocabulary.
  roleAdmin: 'admin',
  roleUser: 'user',
  // Generic toast fallbacks.
  updateFailed: 'Update failed',
  createFailed: 'Create failed',
  deleteFailed: 'Delete failed',
  saveFailed: 'Save failed',
};

const zh: typeof en = {
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  delete: '删除',
  remove: '移除',
  edit: '编辑',
  create: '创建',
  close: '关闭',
  done: '完成',
  copy: '复制',
  copied: '已复制',
  openMenu: '打开菜单',
  actions: '操作',
  name: '名称',
  description: '描述',
  status: '状态',
  loading: '加载中…',
  scope: '作用域',
  scopeGlobal: '全局',
  scopePersonal: '个人',
  roleAdmin: '管理员',
  roleUser: '用户',
  updateFailed: '更新失败',
  createFailed: '创建失败',
  deleteFailed: '删除失败',
  saveFailed: '保存失败',
};

export const commonStrings = { en, zh };
