import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, desc, sql, sql as sql2 } from 'drizzle-orm';
import * as schema from './schema';
import { verifyToken } from './auth';

const auth = async (c: any, next: () => Promise<void>) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  const jwtSecret = c.env.JWT_SECRET_KEY;
  if (!jwtSecret) {
    return c.json({ success: false, message: '服务器错误' }, 500);
  }
  const decoded = await verifyToken(token || '', jwtSecret);
  if (!decoded) return c.json({ success: false, message: '未登录' }, 401);
  c.set('userId', decoded.id);
  c.set('username', decoded.username);
  c.set('userRole', decoded.role);
  c.set('userExp', decoded.exp);
  await next();
};

export const registerNotificationRoutes = (app: Hono) => {
  // // console.log('[通知] 开始注册路由...');
  
  // 获取通知列表 GET /api/notifications
  app.get('/api/notifications', auth, async (c) => {    
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');
    const role = c.get('userRole') || 'user';
    const page = Math.max(1, parseInt(c.req.query('page') || '1'));
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20')));
    const offset = (page - 1) * limit;
    const readFilter = c.req.query('read');

    const isAdmin = role === 'admin' || role === 'superadmin';
    
    if (isAdmin) {
      let whereClause = undefined;
      if (readFilter === '0') {
        whereClause = eq(schema.notifications.read, 0);
      } else if (readFilter === '1') {
        whereClause = eq(schema.notifications.read, 1);
      }
      
      const notifications = whereClause 
        ? await db.select().from(schema.notifications).where(whereClause).orderBy(desc(schema.notifications.createdAt)).limit(limit).offset(offset).all()
        : await db.select().from(schema.notifications).orderBy(desc(schema.notifications.createdAt)).limit(limit).offset(offset).all();
      
      const unreadResult = await db.select({ cnt: sql<number>`count(*)` })
        .from(schema.notifications)
        .where(eq(schema.notifications.read, 0))
        .get();
      return c.json({ success: true, data: notifications, unreadCount: unreadResult?.cnt || 0 });
    } else {
      let notifications;
      if (readFilter === '0') {
        // 未读
        notifications = await db.select()
          .from(schema.notifications)
          .where(and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.read, 0)
          ))
          .orderBy(desc(schema.notifications.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      } else if (readFilter === '1') {
        // 已读
        notifications = await db.select()
          .from(schema.notifications)
          .where(and(
            eq(schema.notifications.userId, userId),
            eq(schema.notifications.read, 1)
          ))
          .orderBy(desc(schema.notifications.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      } else {
        // 全部
        notifications = await db.select()
          .from(schema.notifications)
          .where(eq(schema.notifications.userId, userId))
          .orderBy(desc(schema.notifications.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      }
      
      const unreadResult = await db.select({ cnt: sql<number>`count(*)` })
        .from(schema.notifications)
        .where(and(
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.read, 0)
        ))
        .get();
      return c.json({ success: true, data: notifications, unreadCount: unreadResult?.cnt || 0 });
    }
  });

  // 标记已读 PUT /api/notifications/:id/read
  app.put('/api/notifications/:id/read', auth, async (c) => {
    const db = drizzle(c.env.DB);
    const notificationId = c.req.param('id');
    await db.update(schema.notifications)
      .set({ read: 1 })
      .where(eq(schema.notifications.id, notificationId));
    return c.json({ success: true });
  });

  // 标记全部已读 PUT /api/notifications/read-all
  app.put('/api/notifications/read-all', auth, async (c) => {
    const db = drizzle(c.env.DB);
    const userId = c.get('userId');
    const role = c.get('userRole') || 'user';
    const isAdmin = role === 'admin' || role === 'superadmin';
    
    if (isAdmin) {
      await db.update(schema.notifications)
        .set({ read: 1 })
        .where(eq(schema.notifications.read, 0));
    } else {
      await db.update(schema.notifications)
        .set({ read: 1 })
        .where(and(
          eq(schema.notifications.userId, userId),
          eq(schema.notifications.read, 0)
        ));
    }
    return c.json({ success: true });
  });

  // 删除所有通知 DELETE /api/notifications/all (必须放在 /:id 前���)
  app.delete('/api/notifications/all', auth, async (c) => {
    const db = drizzle(c.env.DB);
    const userId = c.get('userId') as string;
    const role = (c.get('userRole') as string) || 'user';
    const isAdmin = role === 'admin' || role === 'superadmin';

    // console.log('[通知删除全部] userId:', userId, 'role:', role, 'isAdmin:', isAdmin);

    if (isAdmin) {
      // console.log('[通知删除全部] 执行 admin 删除');
      await db.delete(schema.notifications).where(sql2`1=1`).run();
      // console.log('[通知删除全部] admin 删除完成');
    } else {
      // console.log('[通知删除全部] 执行用户删除, userId:', userId);
      await db.delete(schema.notifications).where(sql2`user_id = ${userId}`).run();
      // console.log('[通知删除全部] 用户删除完成');
    }
    
    return c.json({ success: true });
  });

  // 删除已读通知 DELETE /api/notifications/clear-read
  app.delete('/api/notifications/clear-read', auth, async (c) => {
    const db = drizzle(c.env.DB);
    const userId = c.get('userId') as string;
    const role = (c.get('userRole') as string) || 'user';
    const isAdmin = role === 'admin' || role === 'superadmin';

    // console.log('[通知删除已读] userId:', userId, 'role:', role, 'isAdmin:', isAdmin);

    if (isAdmin) {
      await db.delete(schema.notifications).where(sql2`read = 1`).run();
    } else {
      await db.delete(schema.notifications).where(sql2`user_id = ${userId} AND read = 1`).run();
    }
    // console.log('[通知删除已读] 完成');
    
    return c.json({ success: true });
  });

  // 删除通知 DELETE /api/notifications/:id
  app.delete('/api/notifications/:id', auth, async (c) => {
    const db = drizzle(c.env.DB);
    const notificationId = c.req.param('id');
    // console.log('[通知删除] id:', notificationId);
    try {
      await db.delete(schema.notifications).where(eq(schema.notifications.id, notificationId)).run();
      // console.log('[通知删除] 成功');
    } catch (e) {
      console.error('[通知删除] 错误:', e);
    }
    return c.json({ success: true });
  });

  // // console.log('[通知] 路由已注册');
};