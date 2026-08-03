import { describe, it, expect } from 'vitest';
import { Trie, PathTrie } from './trie';

describe('Trie', () => {
  it('insert/search 基本行为', () => {
    const trie = new Trie();
    trie.insert('hello');
    expect(trie.search('hello')).toBe(true);
    expect(trie.search('hell')).toBe(false);
    expect(trie.search('world')).toBe(false);
  });

  it('startsWith 前缀匹配', () => {
    const trie = new Trie();
    trie.insert('hello');
    trie.insert('help');
    trie.insert('world');
    expect(trie.startsWith('hel')).toBe(true);
    expect(trie.startsWith('he')).toBe(true);
    expect(trie.startsWith('wor')).toBe(true);
    expect(trie.startsWith('xyz')).toBe(false);
  });

  it('autocomplete 返回所有前缀词', () => {
    const trie = new Trie();
    trie.insert('hello');
    trie.insert('help');
    trie.insert('heaven');
    trie.insert('world');
    const results = trie.autocomplete('he');
    expect(results).toContain('hello');
    expect(results).toContain('help');
    expect(results).toContain('heaven');
    expect(results).not.toContain('world');
  });

  it('autocomplete 无匹配返回空数组', () => {
    const trie = new Trie();
    trie.insert('hello');
    expect(trie.autocomplete('zz')).toEqual([]);
  });

  it('delete 移除词且不影响其他词', () => {
    const trie = new Trie();
    trie.insert('hello');
    trie.insert('hell');
    expect(trie.delete('hello')).toBe(true);
    expect(trie.search('hello')).toBe(false);
    expect(trie.search('hell')).toBe(true);
    expect(trie.delete('nope')).toBe(false);
  });

  it('getSize 与 getAllWords', () => {
    const trie = new Trie();
    trie.insert('hello');
    trie.insert('world');
    expect(trie.getSize()).toBe(2);
    expect(trie.getAllWords()).toEqual(expect.arrayContaining(['hello', 'world']));
  });
});

describe('PathTrie', () => {
  it('insertPath 按 / 分割存储', () => {
    const trie = new PathTrie();
    trie.insertPath('/src/components/App.tsx');
    expect(trie.search('/src/components/App.tsx')).toBe(true);
  });

  it('searchByFilename 按文件名匹配', () => {
    const trie = new PathTrie();
    trie.insertPath('/src/components/Button.tsx');
    trie.insertPath('/src/utils/button.ts');
    trie.insertPath('/src/pages/Home.tsx');
    const results = trie.searchByFilename('Button', 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it('前缀搜索支持目录', () => {
    const trie = new PathTrie();
    trie.insertPath('/src/components/Button.tsx');
    trie.insertPath('/src/components/Modal.tsx');
    trie.insertPath('/src/pages/Home.tsx');
    expect(trie.startsWith('/src/components')).toBe(true);
    expect(trie.startsWith('/src/pages')).toBe(true);
    expect(trie.startsWith('/dist')).toBe(false);
  });
});
