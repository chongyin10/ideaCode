/**
 * 形状类型枚举
 */
export enum Shape {
    /** 矩形 */
    Rect = 'rect',
    /** 圆形 */
    Circle = 'circle',
    /** 椭圆 */
    Ellipse = 'ellipse',
    /** 多边形 */
    Polygon = 'polygon',
    /** 折线 */
    Polyline = 'polyline',
    /** 路径 */
    Path = 'path',
    /** 图片 */
    Image = 'image',
    /** HTML 节点 */
    HTML = 'html',
}

/**
 * 形状配置接口
 */
export interface ShapeConfig {
    /** 形状类型 */
    type: Shape;
    /** 圆角半径（仅 Rect） */
    borderRadius?: number;
    /** 多边形顶点（仅 Polygon/Polyline） */
    points?: { x: number; y: number }[];
    /** 路径字符串（仅 Path） */
    path?: string;
    /** 图片地址（仅 Image） */
    src?: string;
    /** HTML 内容（仅 HTML） */
    html?: string;
}

/**
 * 形状绘制器
 */
export class ShapeRenderer {
    /**
     * 绘制形状
     * @param ctx - Canvas 2D 上下文
     * @param shape - 形状配置
     * @param x - 中心 X 坐标
     * @param y - 中心 Y 坐标
     * @param width - 宽度
     * @param height - 高度
     */
    static draw(
        ctx: CanvasRenderingContext2D,
        shape: ShapeConfig,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        switch (shape.type) {
            case Shape.Rect:
                this.drawRect(ctx, x, y, width, height, shape.borderRadius);
                break;
            case Shape.Circle:
                this.drawCircle(ctx, x, y, width, height);
                break;
            case Shape.Ellipse:
                this.drawEllipse(ctx, x, y, width, height);
                break;
            case Shape.Polygon:
                this.drawPolygon(ctx, x, y, shape.points || []);
                break;
            case Shape.Polyline:
                this.drawPolyline(ctx, x, y, shape.points || []);
                break;
            case Shape.Path:
                this.drawPath(ctx, shape.path || '');
                break;
            case Shape.Image:
                // 图片需要异步加载，这里只绘制占位符
                this.drawImagePlaceholder(ctx, x, y, width, height);
                break;
            case Shape.HTML:
                // HTML 节点需要 DOM 操作，Canvas 中绘制占位符
                this.drawHTMLPlaceholder(ctx, x, y, width, height);
                break;
            default:
                this.drawRect(ctx, x, y, width, height);
        }
    }

    /**
     * 绘制圆角矩形
     */
    private static drawRect(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number,
        radius: number = 0
    ): void {
        const r = Math.min(radius, width / 2, height / 2);
        const left = x - width / 2;
        const top = y - height / 2;

        ctx.beginPath();
        ctx.moveTo(left + r, top);
        ctx.lineTo(left + width - r, top);
        ctx.quadraticCurveTo(left + width, top, left + width, top + r);
        ctx.lineTo(left + width, top + height - r);
        ctx.quadraticCurveTo(left + width, top + height, left + width - r, top + height);
        ctx.lineTo(left + r, top + height);
        ctx.quadraticCurveTo(left, top + height, left, top + height - r);
        ctx.lineTo(left, top + r);
        ctx.quadraticCurveTo(left, top, left + r, top);
        ctx.closePath();
    }

    /**
     * 绘制圆形
     */
    private static drawCircle(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        const radius = Math.min(width, height) / 2;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.closePath();
    }

    /**
     * 绘制椭圆
     */
    private static drawEllipse(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        const radiusX = width / 2;
        const radiusY = height / 2;
        ctx.beginPath();
        ctx.ellipse(x, y, radiusX, radiusY, 0, 0, Math.PI * 2);
        ctx.closePath();
    }

    /**
     * 绘制多边形
     */
    private static drawPolygon(
        ctx: CanvasRenderingContext2D,
        centerX: number,
        centerY: number,
        points: { x: number; y: number }[]
    ): void {
        if (points.length < 3) return;

        ctx.beginPath();
        ctx.moveTo(centerX + points[0].x, centerY + points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(centerX + points[i].x, centerY + points[i].y);
        }
        ctx.closePath();
    }

    /**
     * 绘制折线
     */
    private static drawPolyline(
        ctx: CanvasRenderingContext2D,
        centerX: number,
        centerY: number,
        points: { x: number; y: number }[]
    ): void {
        if (points.length < 2) return;

        ctx.beginPath();
        ctx.moveTo(centerX + points[0].x, centerY + points[0].y);
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(centerX + points[i].x, centerY + points[i].y);
        }
        // 折线不闭合
    }

    /**
     * 绘制路径
     */
    private static drawPath(ctx: CanvasRenderingContext2D, path: string): void {
        // 简化的 SVG 路径解析
        // 实际使用时可以使用更完整的路径解析库
        const path2d = new Path2D(path);
        // 直接设置当前路径为 Path2D
        (ctx as any).__currentPath = path2d;
        // 使用 Path2D 绘制
        ctx.save();
        ctx.stroke(path2d);
        ctx.restore();
    }

    /**
     * 绘制图片占位符
     */
    private static drawImagePlaceholder(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        this.drawRect(ctx, x, y, width, height, 4);
        ctx.fillStyle = '#f3f4f6';
        ctx.fill();
        ctx.strokeStyle = '#d1d5db';
        ctx.stroke();

        // 绘制图片图标
        ctx.fillStyle = '#9ca3af';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🖼️', x, y);
    }

    /**
     * 绘制 HTML 占位符
     */
    private static drawHTMLPlaceholder(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        width: number,
        height: number
    ): void {
        this.drawRect(ctx, x, y, width, height, 4);
        ctx.fillStyle = '#fef3c7';
        ctx.fill();
        ctx.strokeStyle = '#f59e0b';
        ctx.stroke();

        // 绘制 HTML 标签
        ctx.fillStyle = '#f59e0b';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('<HTML>', x, y);
    }

    /**
     * 检查点是否在形状内
     */
    static containsPoint(
        shape: ShapeConfig,
        pointX: number,
        pointY: number,
        shapeX: number,
        shapeY: number,
        width: number,
        height: number
    ): boolean {
        switch (shape.type) {
            case Shape.Rect:
                return (
                    pointX >= shapeX - width / 2 &&
                    pointX <= shapeX + width / 2 &&
                    pointY >= shapeY - height / 2 &&
                    pointY <= shapeY + height / 2
                );
            case Shape.Circle:
                const radius = Math.min(width, height) / 2;
                const dx = pointX - shapeX;
                const dy = pointY - shapeY;
                return dx * dx + dy * dy <= radius * radius;
            case Shape.Ellipse:
                const rx = width / 2;
                const ry = height / 2;
                const edx = pointX - shapeX;
                const edy = pointY - shapeY;
                return (edx * edx) / (rx * rx) + (edy * edy) / (ry * ry) <= 1;
            default:
                return (
                    pointX >= shapeX - width / 2 &&
                    pointX <= shapeX + width / 2 &&
                    pointY >= shapeY - height / 2 &&
                    pointY <= shapeY + height / 2
                );
        }
    }

    /**
     * 获取形状的连接点
     */
    static getAnchorPoint(
        shape: ShapeConfig,
        position: 'top' | 'right' | 'bottom' | 'left',
        x: number,
        y: number,
        width: number,
        height: number
    ): { x: number; y: number } {
        const halfWidth = width / 2;
        const halfHeight = height / 2;

        switch (shape.type) {
            case Shape.Circle:
            case Shape.Ellipse:
                // 圆形/椭圆的边界点
                const rx = halfWidth;
                const ry = halfHeight;
                switch (position) {
                    case 'top':
                        return { x, y: y - ry };
                    case 'right':
                        return { x: x + rx, y };
                    case 'bottom':
                        return { x, y: y + ry };
                    case 'left':
                        return { x: x - rx, y };
                }
                break;
            default:
                // 矩形和其他形状的边界点
                switch (position) {
                    case 'top':
                        return { x, y: y - halfHeight };
                    case 'right':
                        return { x: x + halfWidth, y };
                    case 'bottom':
                        return { x, y: y + halfHeight };
                    case 'left':
                        return { x: x - halfWidth, y };
                }
        }

        return { x, y };
    }
}

export default ShapeRenderer;
