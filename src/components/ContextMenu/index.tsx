import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight } from 'lucide-react';
import './ContextMenu.css';

export interface MenuItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  /** 分组标识，相同 group 的项之间不加分隔线；不同 group 之间自动加分隔线 */
  group?: string;
  /** 排序权重，数字越小越靠前 */
  order?: number;
  /** 子菜单 */
  children?: MenuItem[];
  /** 点击回调 */
  onClick?: () => void;
  /** 插件命令 ID，若设置则由 MenuManager 解析执行 */
  command?: string;
}

interface ContextMenuProps {
  items: MenuItem[];
  x: number;
  y: number;
  visible: boolean;
  onClose: () => void;
}

const ContextMenu = ({ items, x, y, visible, onClose }: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState({ x: 0, y: 0 });
  const submenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 可见时重置坐标，并在 DOM 挂载后做边界检测
  useEffect(() => {
    if (visible) {
      setPos({ x, y });
      setActiveSubmenu(null);
    }
  }, [visible, x, y]);

  useEffect(() => {
    if (!visible || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > winW) nx = winW - rect.width - 8;
    if (ny + rect.height > winH) ny = winH - rect.height - 8;
    if (nx < 0) nx = 8;
    if (ny < 0) ny = 8;
    setPos({ x: nx, y: ny });
  }, [visible, x, y]);

  // 点击外部关闭
  useEffect(() => {
    if (!visible) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // 排除菜单自身及其子菜单
      if (menuRef.current && !menuRef.current.contains(target)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [visible, onClose]);

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled || item.children?.length) return;
    item.onClick?.();
    onClose();
  };

  const handleMouseEnter = (item: MenuItem, el: HTMLElement) => {
    if (!item.children?.length) {
      setActiveSubmenu(null);
      return;
    }
    if (submenuTimeoutRef.current) clearTimeout(submenuTimeoutRef.current);
    const rect = el.getBoundingClientRect();
    const winW = window.innerWidth;
    let subX = rect.right + 2;
    if (subX + 180 > winW) subX = rect.left - 182;
    setSubmenuPos({ x: subX, y: rect.top - 4 });
    setActiveSubmenu(item.id);
  };

  const handleMouseLeaveItem = () => {
    submenuTimeoutRef.current = setTimeout(() => {
      setActiveSubmenu(null);
    }, 150);
  };

  const handleSubmenuEnter = () => {
    if (submenuTimeoutRef.current) clearTimeout(submenuTimeoutRef.current);
  };

  const handleSubmenuLeave = () => {
    submenuTimeoutRef.current = setTimeout(() => {
      setActiveSubmenu(null);
    }, 150);
  };

  // 根据 group 插入分隔线
  const renderItems = (list: MenuItem[]) => {
    const result: React.ReactNode[] = [];
    let lastGroup: string | undefined;
    list.forEach((item, index) => {
      if (index > 0 && item.group !== lastGroup) {
        result.push(<div key={`sep-${index}`} className="context-menu__separator" />);
      }
      lastGroup = item.group;
      result.push(
        <div
          key={item.id}
          className={`context-menu__item ${item.disabled ? 'disabled' : ''} ${
            activeSubmenu === item.id && item.children?.length ? 'has-submenu' : ''
          }`}
          onClick={() => handleItemClick(item)}
          onMouseEnter={(e) => handleMouseEnter(item, e.currentTarget)}
          onMouseLeave={handleMouseLeaveItem}
        >
          {item.icon && <span className="context-menu__icon">{item.icon}</span>}
          <span className="context-menu__label">{item.label}</span>
          {item.shortcut && <span className="context-menu__shortcut">{item.shortcut}</span>}
          {item.children && item.children.length > 0 && (
            <span className="context-menu__arrow">
              <ChevronRight size={12} strokeWidth={1.5} />
            </span>
          )}
        </div>
      );
    });
    return result;
  };

  if (!visible) return null;

  const menuNode = (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {renderItems(items)}
    </div>
  );

  return (
    <>
      {createPortal(menuNode, document.body)}
      {activeSubmenu && (
        <SubMenuPortal
          key={activeSubmenu}
          items={items.find((i) => i.id === activeSubmenu)?.children ?? []}
          x={submenuPos.x}
          y={submenuPos.y}
          onClose={onClose}
          onMouseEnter={handleSubmenuEnter}
          onMouseLeave={handleSubmenuLeave}
        />
      )}
    </>
  );
};

interface SubMenuPortalProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

const SubMenuPortal = ({ items, x, y, onClose, onMouseEnter, onMouseLeave }: SubMenuPortalProps) => {
  return createPortal(
    <div
      className="context-menu context-menu--submenu"
      style={{ left: x, top: y }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {items.map((child) => (
        <div
          key={child.id}
          className={`context-menu__item ${child.disabled ? 'disabled' : ''}`}
          onClick={() => {
            if (!child.disabled) {
              child.onClick?.();
              onClose();
            }
          }}
        >
          {child.icon && <span className="context-menu__icon">{child.icon}</span>}
          <span className="context-menu__label">{child.label}</span>
          {child.shortcut && <span className="context-menu__shortcut">{child.shortcut}</span>}
        </div>
      ))}
    </div>,
    document.body
  );
};

export default ContextMenu;
