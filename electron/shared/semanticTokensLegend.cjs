/**
 * 语义高亮 token 类型/修饰符 legend（Monaco + tsserver 共享常量）
 *
 * 必须与 typescript-language-server 实际返回的 legend 保持一致，
 * 否则 semantic tokens 的索引将错位，导致着色异常。
 */

const SEMANTIC_TOKEN_TYPES = [
  'class', 'enum', 'interface', 'namespace', 'typeParameter', 'type',
  'parameter', 'variable', 'enumMember', 'property', 'function', 'member',
];

const SEMANTIC_TOKEN_MODIFIERS = [
  'declaration', 'static', 'async', 'readonly', 'defaultLibrary', 'local',
];

module.exports = { SEMANTIC_TOKEN_TYPES, SEMANTIC_TOKEN_MODIFIERS };
