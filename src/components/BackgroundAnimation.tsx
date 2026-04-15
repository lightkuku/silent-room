import React, { useEffect, useRef } from 'react';

interface Shape {
  id: number;
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  rotation: number;
  rotationSpeed: number;
  type: 'circle' | 'square' | 'triangle';
  opacity: number;
  color: string;
}

const colors = [
  'rgba(99, 102, 241, 0.8)',  // indigo
  'rgba(168, 85, 247, 0.58)',  // purple
  'rgba(236, 72, 153, 0.65)',  // pink
  'rgba(59, 130, 246, 0.4)',  // blue
  'rgba(34, 197, 94, 0.5)',   // green
  'rgba(251, 146, 60, 0.3)',  // orange
];

export const BackgroundAnimation: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapesRef = useRef<Shape[]>([]);
  const animationRef = useRef<number>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    const createShape = (): Shape => {
      const types: ('circle' | 'square' | 'triangle')[] = ['circle', 'square', 'triangle'];
      return {
        id: Math.random(),
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        size: 50 + Math.random() * 60,
        speedX: (Math.random() - 0.5) * 0.5,
        speedY: (Math.random() - 0.5) * 0.5,
        rotation: Math.random() * Math.PI * 2,
        rotationSpeed: (Math.random() - 0.5) * 0.02,
        type: types[Math.floor(Math.random() * types.length)],
        opacity: 0.1 + Math.random() * 0.2,
        color: colors[Math.floor(Math.random() * colors.length)],
      };
    };

    const initShapes = () => {
      // 减少数量，提高除数
      const shapeCount = Math.floor((canvas.width * canvas.height) / 100000);
      shapesRef.current = Array.from({ length: shapeCount }, createShape);
    };

    const drawShape = (ctx: CanvasRenderingContext2D, shape: Shape) => {
      ctx.save();
      ctx.translate(shape.x, shape.y);
      ctx.rotate(shape.rotation);
      ctx.fillStyle = shape.color;
      ctx.globalAlpha = shape.opacity;

      switch (shape.type) {
        case 'circle':
          ctx.beginPath();
          ctx.arc(0, 0, shape.size / 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'square':
          ctx.fillRect(-shape.size / 2, -shape.size / 2, shape.size, shape.size);
          break;
        case 'triangle':
          ctx.beginPath();
          ctx.moveTo(0, -shape.size / 2);
          ctx.lineTo(shape.size / 2, shape.size / 2);
          ctx.lineTo(-shape.size / 2, shape.size / 2);
          ctx.closePath();
          ctx.fill();
          break;
      }

      ctx.restore();
    };

    let lastTime = 0;
    const targetFPS = 24; // 限制帧率
    const frameInterval = 1000 / targetFPS;

    const animate = (currentTime: number) => {
      // 限制帧率
      if (currentTime - lastTime < frameInterval) {
        animationRef.current = requestAnimationFrame(animate);
        return;
      }
      lastTime = currentTime - (currentTime % frameInterval);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      shapesRef.current.forEach(shape => {
        shape.x += shape.speedX;
        shape.y += shape.speedY;
        shape.rotation += shape.rotationSpeed;

        // 边界检测，循环移动
        if (shape.x < -shape.size) shape.x = canvas.width + shape.size;
        if (shape.x > canvas.width + shape.size) shape.x = -shape.size;
        if (shape.y < -shape.size) shape.y = canvas.height + shape.size;
        if (shape.y > canvas.height + shape.size) shape.y = -shape.size;

        drawShape(ctx, shape);
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    resizeCanvas();
    initShapes();
    animationRef.current = requestAnimationFrame(animate);

    const handleVisibilityChange = () => {
      if (document.hidden) {
        // 页面不可见时暂停
        if (animationRef.current) {
          cancelAnimationFrame(animationRef.current);
          animationRef.current = undefined;
        }
      } else {
        // 页面可见时恢复
        lastTime = 0;
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    window.addEventListener('resize', () => {
      resizeCanvas();
      initShapes();
    });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
};
