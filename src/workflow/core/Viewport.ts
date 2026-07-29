import type { Point } from './Graph';

/**
 * Viewport - 画布视口状态与坐标变换
 *
 * 管理画布的平移偏移与缩放比例，提供：
 * - 屏幕坐标与世界坐标的相互转换
 * - 鼠标事件位置到画布坐标系的转换
 */
export class Viewport {
    /** 世界坐标原点在屏幕坐标系中的偏移 */
    offset: Point;
    /** 缩放比例（1 为原始大小） */
    scale: number;

    constructor(initialOffset: Point = { x: 0, y: 0 }, initialScale: number = 1) {
        this.offset = { ...initialOffset };
        this.scale = initialScale;
    }

    /**
     * 将屏幕坐标转换为世界坐标
     */
    screenToWorld(screenPoint: Point): Point {
        return {
            x: (screenPoint.x - this.offset.x) / this.scale,
            y: (screenPoint.y - this.offset.y) / this.scale,
        };
    }

    /**
     * 将世界坐标转换为屏幕坐标
     */
    worldToScreen(worldPoint: Point): Point {
        return {
            x: worldPoint.x * this.scale + this.offset.x,
            y: worldPoint.y * this.scale + this.offset.y,
        };
    }

    /**
     * 将鼠标事件位置转换为画布屏幕坐标（相对画布左上角）
     */
    eventToScreenPoint(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): Point {
        const rect = canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
        };
    }

    /**
     * 将鼠标事件位置转换为世界坐标
     */
    eventToWorldPoint(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): Point {
        return this.screenToWorld(this.eventToScreenPoint(canvas, e));
    }

    /**
     * 重置视口到指定的偏移与缩放
     */
    reset(offset: Point = { x: 0, y: 0 }, scale: number = 1): void {
        this.offset = { ...offset };
        this.scale = scale;
    }
}
