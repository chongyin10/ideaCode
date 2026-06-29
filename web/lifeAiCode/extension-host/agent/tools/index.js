/**
 * Agent Tools 统一导出
 */

const readFile = require('./readFile');
const getFileTree = require('./getFileTree');
const searchFiles = require('./searchFiles');
const executeShell = require('./executeShell');
const applyEdit = require('./applyEdit');
const writeFile = require('./writeFile');
const readFileOutline = require('./readFileOutline');
const readFileLines = require('./readFileLines');
const searchInFile = require('./searchInFile');
const readFileChunks = require('./readFileChunks');

module.exports = {
  read_file: readFile,
  get_file_tree: getFileTree,
  search_files: searchFiles,
  execute_shell: executeShell,
  apply_edit: applyEdit,
  write_file: writeFile,
  read_file_outline: readFileOutline,
  read_file_lines: readFileLines,
  search_in_file: searchInFile,
  read_file_chunks: readFileChunks,
};
