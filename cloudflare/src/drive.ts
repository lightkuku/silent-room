/**
 * 网盘 Drive API
 * 移植自 BK/server/index.js
 */

import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and, or, isNull, sql, ne } from 'drizzle-orm';
import * as schema from './schema';
import { StorageManager, StorageConfig } from './storage/manager';
import { API, CONFIG } from './routes';
import { verifyToken } from './auth';

// CORS 辅助函数
function getAllowedOrigins(env: Bindings): string[] {
  return (env.ALLOWED_DOMAINS || '').split(',').map(o => o.trim()).filter(Boolean);
}

function getCorsHeaders(env: Bindings, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  const allowedOrigins = getAllowedOrigins(env);
  
  if (origin && allowedOrigins.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-CSRF-Token, x-csrf-token'
    };
  }
  
  return {};
}

type Bindings = {
  DB: D1Database;
  UPLOADS: KVNamespace;
  CHAT: DurableObjectNamespace;
  R2: R2Bucket;
  ADMIN_PASSWORD: string;
  ALLOWED_DOMAINS?: string;
};

type Context = {
  db: ReturnType<typeof drizzle>;
  user: { id: string } | null;
  userId: string;
};

class DriveContext {
  private c: any;
  private _db: ReturnType<typeof drizzle> | null = null;
  private _user: { id: string; username?: string } | null = null;
  private _userId: string = '';

  constructor(c: any) {
    this.c = c;
  }

  async init(): Promise<{ success: boolean; error?: string }> {
    try {
      const DB: D1Database = this.c.env.DB as D1Database;
      this._db = drizzle(DB);
      
      const auth = this.c.req.header('Authorization');
      if (!auth) {
        return { success: false, error: '未登录' };
      }
      
      this._user = await verifyToken(auth) as { id: string; username?: string } | null;
      if (!this._user) {
        return { success: false, error: '无效的token' };
      }
      
      this._userId = this._user.id;
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async initOptional(): Promise<{ success: boolean }> {
    try {
      const DB: D1Database = this.c.env.DB as D1Database;
      this._db = drizzle(DB);
      
      const auth = this.c.req.header('Authorization');
      if (auth) {
        this._user = await verifyToken(auth) as { id: string; username?: string } | null;
        if (this._user) {
          this._userId = this._user.id;
        }
      }
      return { success: true };
    } catch (e: any) {
      return { success: false };
    }
  }

  get db(): ReturnType<typeof drizzle> {
    return this._db!;
  }

  get user(): { id: string } | null {
    return this._user;
  }

  get userId(): string {
    return this._userId;
  }

  json(data: any, status: number = 200): Response {
    return this.c.json(data, status);
  }

  param(name: string): string {
    return this.c.req.param(name);
  }

  query(name: string): string | null {
    return this.c.req.query(name);
  }

  async jsonBody<T>(): Promise<T> {
    return this.c.req.json();
  }

  get env() {
    return this.c.env;
  }

  get req() {
    return this.c.req;
  }
}

class DriveRouter {
  private app: Hono;
  private ctx!: DriveContext;

  constructor(app: Hono) {
    this.app = app;
  }

  register() {
    this.storage();
    this.filesById();
    this.files();
    this.shared();
    this.shareOptions();
    this.upload();
    this.sharedUpload();
    this.sharedDownload();
    this.sharedRename();
    this.createFolder();
    this.deleteFile();
    this.batchDelete();
    this.share();
    this.move();
    this.rename();
    this.download();
    this.sharedWithMe();
    this.restore();
    this.permanentDelete();
    
  }

  private storage() {
    this.app.get(API.drive.storage, async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      
      const [userRow, storageTypeRow] = await Promise.all([
        db.select({ disk: schema.users.disk }).from(schema.users).where(eq(schema.users.id, userId)).get(),
        db.select({ value: schema.system_settings.value }).from(schema.system_settings).where(eq(schema.system_settings.key, 'storageType')).get()
      ]);
      
      const STORAGE_LIMIT = userRow?.disk || 5 * 1024 * 1024 * 1024;
      const storageType = storageTypeRow?.value || 'r2';
      
      const result = await db.select({ total: sql<number>`SUM(${schema.drive_files.size})` })
        .from(schema.drive_files)
        .where(and(
          eq(schema.drive_files.ownerId, userId),
          eq(schema.drive_files.isDeleted, 0),
          eq(schema.drive_files.storageType, storageType)
        ))
        .get();
      
      const usedStorage = result?.total || 0;
      
      return ctx.json({
        success: true,
        data: {
          used: usedStorage,
          limit: STORAGE_LIMIT,
          available: Math.max(0, STORAGE_LIMIT - usedStorage)
        }
      });
    });
  }

  private filesById() {
    this.app.get(API.drive.file, async (c) => {
      const ctx = new DriveContext(c);
      await ctx.initOptional();
      
      const { db } = ctx;
      const id = ctx.param('id');
      
      const folder = await db.select().from(schema.drive_files)
        .where(and(eq(schema.drive_files.id, id), eq(schema.drive_files.isDeleted, 0)))
        .get();
      
      if (!folder) {
        return ctx.json({ success: false, message: '文件夹不存在' }, 404);
      }
      
      if (folder.type !== 'folder') {
        return ctx.json({ success: false, message: '不是文件夹' }, 400);
      }
      
      const files = await db.select().from(schema.drive_files)
        .where(and(eq(schema.drive_files.parentId, id), eq(schema.drive_files.isDeleted, 0)))
        .orderBy(schema.drive_files.type, schema.drive_files.name);
      
      return ctx.json({ success: true, data: files });
    });
  }

  private files() {
    this.app.get(API.drive.list, async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const parentIdParam = ctx.query('parentId');
      const view = ctx.query('view') || 'my';
      
      const storageTypeRow = await db.select({ value: schema.system_settings.value })
        .from(schema.system_settings)
        .where(eq(schema.system_settings.key, 'storageType'))
        .get();
      const storageType = storageTypeRow?.value || 'r2';
      
      let parentId = null;
      if (parentIdParam && parentIdParam !== 'null' && parentIdParam !== 'undefined') {
        parentId = parentIdParam;
      }
      
      let files;
      
      if (view === 'recent') {
        const fiveDaysAgo = Math.floor((Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000);
        
        let query;
        if (parentId) {
          query = db.select({
            id: schema.drive_files.id,
            name: schema.drive_files.name,
            type: schema.drive_files.type,
            size: schema.drive_files.size,
            url: schema.drive_files.url,
            ownerId: schema.drive_files.ownerId,
            parentId: schema.drive_files.parentId,
            storageType: schema.drive_files.storageType,
            isShared: schema.drive_files.isShared,
            sharePermission: schema.drive_files.sharePermission,
            shareFrom: schema.drive_files.shareFrom,
            shareToUsers: schema.drive_files.shareToUsers,
            shareToGroups: schema.drive_files.shareToGroups,
            shareLinkToken: schema.drive_files.shareLinkToken,
            deletedAt: schema.drive_files.deletedAt,
            isDeleted: schema.drive_files.isDeleted,
            isEncrypted: schema.drive_files.isEncrypted,
            createdAt: schema.drive_files.createdAt,
            updatedAt: schema.drive_files.updatedAt,
            ownerName: schema.users.name
          })
            .from(schema.drive_files)
            .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
            .where(and(
              eq(schema.drive_files.ownerId, userId),
              eq(schema.drive_files.isDeleted, 0),
              eq(schema.drive_files.parentId, parentId),
              sql`${schema.drive_files.storageType} = ${storageType}`,
              sql`${schema.drive_files.createdAt} >= ${fiveDaysAgo}`
            ))
            .orderBy(sql`${schema.drive_files.createdAt} DESC`);
        } else {
          query = db.select({
            id: schema.drive_files.id,
            name: schema.drive_files.name,
            type: schema.drive_files.type,
            size: schema.drive_files.size,
            url: schema.drive_files.url,
            ownerId: schema.drive_files.ownerId,
            parentId: schema.drive_files.parentId,
            storageType: schema.drive_files.storageType,
            isShared: schema.drive_files.isShared,
            sharePermission: schema.drive_files.sharePermission,
            shareFrom: schema.drive_files.shareFrom,
            shareToUsers: schema.drive_files.shareToUsers,
            shareToGroups: schema.drive_files.shareToGroups,
            shareLinkToken: schema.drive_files.shareLinkToken,
            deletedAt: schema.drive_files.deletedAt,
            isDeleted: schema.drive_files.isDeleted,
            isEncrypted: schema.drive_files.isEncrypted,
            createdAt: schema.drive_files.createdAt,
            updatedAt: schema.drive_files.updatedAt,
            ownerName: schema.users.name
          })
            .from(schema.drive_files)
            .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
            .where(and(
              eq(schema.drive_files.ownerId, userId),
              eq(schema.drive_files.isDeleted, 0),
              sql`${schema.drive_files.parentId} IS NULL`,
              sql`${schema.drive_files.storageType} = ${storageType}`,
              sql`${schema.drive_files.createdAt} >= ${fiveDaysAgo}`
            ))
            .orderBy(sql`${schema.drive_files.createdAt} DESC`);
        }
        files = await query.all();
      } else if (view === 'trash') {
        files = await db.select({
          id: schema.drive_files.id,
          name: schema.drive_files.name,
          type: schema.drive_files.type,
          size: schema.drive_files.size,
          url: schema.drive_files.url,
          ownerId: schema.drive_files.ownerId,
          parentId: schema.drive_files.parentId,
          isShared: schema.drive_files.isShared,
          sharePermission: schema.drive_files.sharePermission,
          shareFrom: schema.drive_files.shareFrom,
          shareToUsers: schema.drive_files.shareToUsers,
          shareToGroups: schema.drive_files.shareToGroups,
          shareLinkToken: schema.drive_files.shareLinkToken,
          deletedAt: schema.drive_files.deletedAt,
          isDeleted: schema.drive_files.isDeleted,
          isEncrypted: schema.drive_files.isEncrypted,
          createdAt: schema.drive_files.createdAt,
          updatedAt: schema.drive_files.updatedAt,
          ownerName: schema.users.name
        })
        .from(schema.drive_files)
        .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
        .where(and(
          eq(schema.drive_files.ownerId, userId),
          eq(schema.drive_files.isDeleted, 1),
          eq(schema.drive_files.storageType, storageType)
        ));
      } else if (view === 'shared') {
        const userGroups = await db.select({ sessionId: schema.session_participants.sessionId })
          .from(schema.session_participants)
          .where(eq(schema.session_participants.userId, userId))
          .all();
        const userGroupIds = userGroups.map(g => g.sessionId);
        
        let query;
        if (parentId) {
          // 如果有 parentId，只获取该目录下的文件和子目录
          query = db.select({
            id: schema.drive_files.id,
            name: schema.drive_files.name,
            type: schema.drive_files.type,
            size: schema.drive_files.size,
            url: schema.drive_files.url,
            ownerId: schema.drive_files.ownerId,
            parentId: schema.drive_files.parentId,
            storageType: schema.drive_files.storageType,
            isShared: schema.drive_files.isShared,
            sharePermission: schema.drive_files.sharePermission,
            shareFrom: schema.drive_files.shareFrom,
            shareToUsers: schema.drive_files.shareToUsers,
            shareToGroups: schema.drive_files.shareToGroups,
            shareLinkToken: schema.drive_files.shareLinkToken,
            deletedAt: schema.drive_files.deletedAt,
            isDeleted: schema.drive_files.isDeleted,
            isEncrypted: schema.drive_files.isEncrypted,
            createdAt: schema.drive_files.createdAt,
            updatedAt: schema.drive_files.updatedAt,
            ownerName: schema.users.name
          })
            .from(schema.drive_files)
            .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
            .where(and(
              eq(schema.drive_files.parentId, parentId),
              eq(schema.drive_files.isDeleted, 0),
              eq(schema.drive_files.storageType, storageType)
            ));
        } else {
          // 根目录：只显示直接共享给该用户的根目录文件和用户所在群组共享的根目录文件
          query = db.select({
            id: schema.drive_files.id,
            name: schema.drive_files.name,
            type: schema.drive_files.type,
            size: schema.drive_files.size,
            url: schema.drive_files.url,
            ownerId: schema.drive_files.ownerId,
            parentId: schema.drive_files.parentId,
            storageType: schema.drive_files.storageType,
            isShared: schema.drive_files.isShared,
            sharePermission: schema.drive_files.sharePermission,
            shareFrom: schema.drive_files.shareFrom,
            shareToUsers: schema.drive_files.shareToUsers,
            shareToGroups: schema.drive_files.shareToGroups,
            shareLinkToken: schema.drive_files.shareLinkToken,
            deletedAt: schema.drive_files.deletedAt,
            isDeleted: schema.drive_files.isDeleted,
            isEncrypted: schema.drive_files.isEncrypted,
            createdAt: schema.drive_files.createdAt,
            updatedAt: schema.drive_files.updatedAt,
            ownerName: schema.users.name
          })
            .from(schema.drive_files)
            .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
            .where(and(
              eq(schema.drive_files.isDeleted, 0),
              eq(schema.drive_files.storageType, storageType),
              sql`${schema.drive_files.parentId} IS NULL`
            ));
        }
        
        const allFiles = await query.all();
        
        files = allFiles.filter((file: any) => {
          if (file.ownerId === userId) return false;
          
          const shareToUsers = file.shareToUsers ? JSON.parse(file.shareToUsers) : [];
          const shareToGroups = file.shareToGroups ? JSON.parse(file.shareToGroups) : [];
          
          const hasUserShare = shareToUsers.includes(userId);
          const hasAllGroups = shareToGroups.includes('__all__');
          const hasGroupShare = hasAllGroups || shareToGroups.some((g: string) => userGroupIds.includes(g));
          
          return hasUserShare || hasGroupShare;
        });
        
        files.sort((a: any, b: any) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === 'folder' ? -1 : 1;
        });
      } else {
        // 使用 leftJoin 获取 ownerName
        if (parentId) {
          files = await db.select({
            ...schema.drive_files,
            ownerName: schema.users.name
          })
            .from(schema.drive_files)
            .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
            .where(and(
              eq(schema.drive_files.ownerId, userId),
              eq(schema.drive_files.isDeleted, 0),
              eq(schema.drive_files.parentId, parentId),
              eq(schema.drive_files.storageType, storageType)
            ));
        } else {
          files = await db.select({
            ...schema.drive_files,
            ownerName: schema.users.name
          })
            .from(schema.drive_files)
            .leftJoin(schema.users, eq(schema.drive_files.ownerId, schema.users.id))
            .where(and(
              eq(schema.drive_files.ownerId, userId),
              eq(schema.drive_files.isDeleted, 0),
              isNull(schema.drive_files.parentId),
              eq(schema.drive_files.storageType, storageType)
            ));
        }
      }
      
      return ctx.json({ success: true, data: files });
    });
  }

  private shared() {
    this.app.get(API.drive.sharedLink, async (c) => {
      const ctx = new DriveContext(c);
      await ctx.initOptional();
      
      const { db } = ctx;
      const token = ctx.param('token');
      const path = ctx.query('path');
      const folderId = ctx.query('folderId');
      
      const shareFolder = await db.select().from(schema.drive_files)
        .where(eq(schema.drive_files.shareLinkToken, token))
        .get();
      
      if (!shareFolder) {
        
        return ctx.json({ success: false, message: '分享链接无效或已失效' }, 404);
      }
      
      if (shareFolder.isDeleted === 1) {
        
        return ctx.json({ success: false, message: '分享链接已失效' }, 404);
      }
      
      // 如果有 folderId，直接通过 id 获取子目录内容
      if (folderId) {
        const folder = await db.select().from(schema.drive_files)
          .where(and(
            eq(schema.drive_files.id, folderId),
            eq(schema.drive_files.isDeleted, 0)
          ))
          .get();
        
        if (!folder) {
          return ctx.json({ success: false, message: '文件夹不存在' }, 404);
        }
        
        const children = await db.select().from(schema.drive_files)
          .where(and(eq(schema.drive_files.parentId, folderId), eq(schema.drive_files.isDeleted, 0)))
          .orderBy(schema.drive_files.type, schema.drive_files.name);
        
        return ctx.json({ 
          success: true, 
          data: {
            ...folder,
            children
          }
        });
      }
      
      // 通过 path 查找
      if (shareFolder.type === 'folder') {
        let targetParentId = shareFolder.id;
        let currentFolder = shareFolder;
        
        if (path) {
          const pathParts = String(path).split('/').filter((p: string) => p);
          for (const part of pathParts) {
            const child = await db.select().from(schema.drive_files)
              .where(and(
                eq(schema.drive_files.parentId, targetParentId),
                eq(schema.drive_files.name, part),
                eq(schema.drive_files.isDeleted, 0)
              ))
              .get();
            if (!child) {
              return ctx.json({ success: false, message: '路径不存在' }, 404);
            }
            targetParentId = child.id;
          }
        }
        
        const children = await db.select().from(schema.drive_files)
          .where(and(eq(schema.drive_files.parentId, targetParentId), eq(schema.drive_files.isDeleted, 0)))
          .orderBy(schema.drive_files.type, schema.drive_files.name);
        
        return ctx.json({ 
          success: true, 
          data: {
            ...currentFolder,
            children
          }
        });
      }
      
      // 通过 path 查找
      if (shareFolder.type === 'folder') {
        let targetParentId = shareFolder.id;
        let currentFolder = shareFolder;
        
        if (path) {
          const pathParts = String(path).split('/').filter((p: string) => p);
          for (const part of pathParts) {
            const child = await db.select().from(schema.drive_files)
              .where(and(
                eq(schema.drive_files.parentId, targetParentId),
                eq(schema.drive_files.name, part),
                eq(schema.drive_files.isDeleted, 0)
              ))
              .get();
            if (!child) {
              return ctx.json({ success: false, message: '路径不存在' }, 404);
            }
            targetParentId = child.id;
          }
        }
        
        const children = await db.select().from(schema.drive_files)
          .where(and(eq(schema.drive_files.parentId, targetParentId), eq(schema.drive_files.isDeleted, 0)))
          .orderBy(schema.drive_files.type, schema.drive_files.name);
        
        return ctx.json({ 
          success: true, 
          data: {
            ...currentFolder,
            children
          }
        });
      }
      
      return ctx.json({ 
        success: true, 
        data: shareFolder,
        downloadUrl: shareFolder.url
      });
    });
  }

  private shareOptions() {
    this.app.get(API.drive.shareOptions, async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      
      // 获取当前用户参与的所有私聊会话
      const friendSessions = await db.select({ id: schema.sessions.id })
        .from(schema.sessions)
        .innerJoin(schema.session_participants, eq(schema.sessions.id, schema.session_participants.sessionId))
        .where(and(
          eq(schema.session_participants.userId, userId),
          eq(schema.sessions.type, 'friend')
        ))
        .all();
      
      const friendSessionIds = friendSessions.map(s => s.id);
      
      // 批量获取所有私聊会话的参与者
      const allParticipants = friendSessionIds.length > 0
        ? await db.select({ sessionId: schema.session_participants.sessionId, userId: schema.session_participants.userId })
            .from(schema.session_participants)
            .where(sql`${schema.session_participants.sessionId} IN ${friendSessionIds}`)
            .all()
        : [];
      
      // 找出所有其他用户的ID（去重）
      const otherUserIds = [...new Set(
        allParticipants
          .filter(p => p.userId !== userId)
          .map(p => p.userId)
      )];
      
      // 批量获取用户信息
      const userInfos = otherUserIds.length > 0
        ? await db.select({
            id: schema.users.id,
            name: schema.users.name,
            username: schema.users.username,
            avatar: schema.users.avatar
          }).from(schema.users).where(sql`${schema.users.id} IN ${otherUserIds}`).all()
        : [];
      
      // 获取群组列表
      const groups = await db.select({
        id: schema.sessions.id,
        name: schema.sessions.name
      })
      .from(schema.sessions)
      .innerJoin(schema.session_participants, eq(schema.sessions.id, schema.session_participants.sessionId))
      .where(and(eq(schema.session_participants.userId, userId), eq(schema.sessions.type, 'group')))
      .all();
      
      return ctx.json({ success: true, data: { users: userInfos, groups } });
    });
  }

  private authMiddleware() {
    return async (c: any, next: () => Promise<void>) => {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ success: false, message: '未登录' }, 401);
      }
      const jwtSecret = c.env.JWT_SECRET_KEY;
      if (!jwtSecret) {
        return c.json({ success: false, message: '服务器错误' }, 500);
      }
      const decoded = await verifyToken(token, jwtSecret);
      if (!decoded) {
        return c.json({ success: false, message: '登录已过期' }, 401);
      }
      c.set('userId', decoded.id);
      c.set('username', decoded.username);
      c.set('userRole', decoded.role);
      await next();
    };
  }

  private csrfProtection() {
    return async (c: any, next: () => Promise<void>) => {
      const method = c.req.method;
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        await next();
        return;
      }
      const csrfToken = c.req.header('X-CSRF-Token') || c.req.header('x-csrf-token');
      if (!csrfToken) {
        console.error('[CSRF] Missing token');
        return c.json({ success: false, message: 'CSRF token 缺失' }, 403);
      }
      await next();
    };
  }

  private upload() {
    this.app.post(API.drive.upload, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      try {
        const init = await ctx.init();
        if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
        
        const { db, userId } = ctx;
        const R2: any = ctx.env.R2;
        const UPLOADS: any = ctx.env.UPLOADS;
        
        // 文件上传最大容量限制
        const MAX_FILE_SIZE = ctx.env.MAX_UPLOAD_SIZE;

        const settings = await loadDriveSettings(db);
        const storageType = settings.storageType || 'r2';
        
        const formData = await c.req.formData();
        const parentId = formData.get('parentId') as string || null;
        const encryptedName = formData.get('name') as string;
        const isEncrypted = formData.get('isEncrypted') as string;
        const file = formData.get('file') as File;
        const originalSize = formData.get('originalSize') ? parseInt(formData.get('originalSize') as string) : file.size;
        
        if (!file) {
          return ctx.json({ success: false, message: '请选择文件' }, 400);
        }

        // 验证文件大小
        if (file.size > MAX_FILE_SIZE * 1024 * 1024) {
          return ctx.json({ success: false, message: `文件大小超过限制（最大 ${MAX_FILE_SIZE} MB）` }, 400);
        }
        
        // 验证文件类型（已禁用，支持所有文件类型）
        // const fileType = file.type.toLowerCase();
        // if (fileType && !ALLOWED_TYPES.includes(fileType)) {
        //   return ctx.json({ success: false, message: '不支持的文件类型' }, 400);
        // }
        
        // 获取用户的存储空间限制（默认5GB）
        const userRow = await db.select({ disk: schema.users.disk })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .get();
        const STORAGE_LIMIT = userRow?.disk || 5 * 1024 * 1024 * 1024;
        
        // 使用加密后的文件大小来计算
        const encryptedSize = file.size;
        
        const result = await db.select({ total: sql<number>`COALESCE(SUM(${schema.drive_files.size}), 0)` })
          .from(schema.drive_files)
          .where(and(eq(schema.drive_files.ownerId, userId), eq(schema.drive_files.isDeleted, 0)))
          .get();
        const usedStorage = result?.total || 0;
        
        if (usedStorage + encryptedSize > STORAGE_LIMIT) {
          return ctx.json({ 
            success: false, 
            message: `存储空间不足，当前已使用 ${(usedStorage / 1024 / 1024 / 1024).toFixed(2)} GB`
          }, 403);
        }
        
        const fileId = crypto.randomUUID();
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // 验证并清理文件名，防止路径遍历攻击
        let safeFileName = file.name;
        // 移除路径分隔符和上级目录引用
        safeFileName = safeFileName.replace(/[\/\\..]/g, '_');
        // 移除前后空格
        safeFileName = safeFileName.trim();
        // 限制文件名长度
        if (safeFileName.length > 255) {
          const ext = safeFileName.lastIndexOf('.');
          if (ext > 0) {
            safeFileName = safeFileName.substring(0, 250) + safeFileName.substring(ext);
          } else {
            safeFileName = safeFileName.substring(0, 255);
          }
        }
        // 如果文件名为空，使用默认名称
        if (!safeFileName) {
          safeFileName = 'unnamed_file';
        }
        
        const key = `${userId}/${Date.now()}_${crypto.randomUUID()}`;
        const url = await uploadToStorage(storageType, key, uint8Array, file.type || 'application/octet-stream', R2, UPLOADS, db);
        
        const finalFileName = encryptedName || file.name;
        const finalIsEncrypted = isEncrypted === 'true' || isEncrypted === true ? 1 : 0;
        
        // 检查文件名是否已存在，如果存在则添加数字后缀
        let targetParentId = parentId === 'null' || !parentId ? null : parentId;
        // 直接使用文件名（加密文件名不应该被修改）
        let finalNameToSave = finalFileName;
        let counter = 1;
        
        while (true) {
          const conditions = [
            eq(schema.drive_files.name, finalNameToSave),
            eq(schema.drive_files.ownerId, userId),
            eq(schema.drive_files.isDeleted, 0)
          ];
          if (targetParentId) {
            conditions.push(eq(schema.drive_files.parentId, targetParentId));
          } else {
            conditions.push(sql`${schema.drive_files.parentId} IS NULL`);
          }
          
          const existingFile = await db.select().from(schema.drive_files)
            .where(and(...conditions))
            .get();
          
          if (!existingFile) {
            break;
          }
          
          // 文件名已存在，添加数字后缀
          const dotIndex = finalFileName.lastIndexOf('.');
          if (dotIndex > 0) {
            const name = finalFileName.substring(0, dotIndex);
            const ext = finalFileName.substring(dotIndex);
            finalNameToSave = `${name}_(${counter})${ext}`;
          } else {
            finalNameToSave = `${finalFileName}_(${counter})`;
          }
          counter++;
        }
        
        // 继承父文件夹的共享设置
        let parentShareInfo: any = null;
        if (parentId && parentId !== 'null') {
          const parentFile = await db.select().from(schema.drive_files)
            .where(eq(schema.drive_files.id, parentId))
            .get();
          if (parentFile && parentFile.isShared === 1) {
            parentShareInfo = {
              isShared: 1,
              shareFrom: parentFile.ownerId,
              sharePermission: parentFile.sharePermission,
              shareLinkToken: parentFile.shareLinkToken,
              shareToUsers: parentFile.shareToUsers,
              shareToGroups: parentFile.shareToGroups
            };
          }
        }
        
        await db.insert(schema.drive_files).values({
          id: fileId,
          name: finalNameToSave,
          type: 'file',
          size: originalSize,
          url: url,
          ownerId: userId,
          parentId: targetParentId,
          storageType: storageType,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isEncrypted: finalIsEncrypted,
          ...(parentShareInfo || {})
        });
        
        const newFile = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, fileId)).get();
        
        return ctx.json({ success: true, data: newFile });
      } catch (e: any) {
        console.error('[Upload Error]', e);
        return ctx.json({ success: false, message: e.message || '上传失败' }, 500);
      }
    });
  }

  private sharedUpload() {
    this.app.post(API.drive.sharedLinkUpload, this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      await ctx.initOptional();
      
      const { db } = ctx;
      const R2: any = ctx.env.R2;
      const UPLOADS: any = ctx.env.UPLOADS;
      const token = ctx.param('token');
      
      const settings = await loadDriveSettings(db);
      const storageType = settings.storageType || 'r2';
      
      const formData = await c.req.formData();
      const parentId = formData.get('parentId') as string || null;
      const encryptedName = formData.get('name') as string;
      const isEncrypted = formData.get('isEncrypted') as string;
      const file = formData.get('file') as File;
      const isEncryptedFile = formData.get('isEncrypted') === 'true';
      const originalSize = formData.get('originalSize') ? parseInt(formData.get('originalSize') as string) : file.size;
      
      const sharedFolder = await db.select().from(schema.drive_files)
        .where(eq(schema.drive_files.shareLinkToken, token))
        .get();
      
      if (!sharedFolder) {
        return ctx.json({ success: false, message: '分享链接无效' }, 404);
      }
      
      // 检查分享文件夹是否存在
      if (sharedFolder.isDeleted === 1) {
        return ctx.json({ success: false, message: '分享文件夹已被删除' }, 404);
      }
      
      if (!file) {
        return ctx.json({ success: false, message: '请选择文件' }, 400);
      }
      
      const fileId = crypto.randomUUID();
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      // 如果文件名加密了，使用加密后的文件名存储
      const finalFileName = encryptedName || file.name;
      
      // 检查文件名是否已存在，如果存在则添加数字后缀
      let targetParentId = parentId === 'null' || !parentId ? sharedFolder.id : parentId;
      let finalNameToSave = finalFileName;
      let counter = 1;
      
      while (true) {
        const existingFile = await db.select().from(schema.drive_files)
          .where(and(
            eq(schema.drive_files.name, finalNameToSave),
            eq(schema.drive_files.parentId, targetParentId),
            eq(schema.drive_files.ownerId, sharedFolder.ownerId),
            eq(schema.drive_files.isDeleted, 0)
          ))
          .get();
        
        if (!existingFile) {
          break;
        }
        
        // 文件名已存在，添加数字后缀
        const dotIndex = finalFileName.lastIndexOf('.');
        if (dotIndex > 0) {
          const name = finalFileName.substring(0, dotIndex);
          const ext = finalFileName.substring(dotIndex);
          finalNameToSave = `${name}_(${counter})${ext}`;
        } else {
          finalNameToSave = `${finalFileName}_(${counter})`;
        }
        counter++;
      }
      
      const key = `shared/${sharedFolder.ownerId}/${Date.now()}_${crypto.randomUUID()}`;
      let url: string;
      try {
        url = await uploadToStorage(storageType, key, uint8Array, file.type || 'application/octet-stream', R2, UPLOADS, db);
      } catch (e: any) {
        return ctx.json({ success: false, message: e.message || '上传失败' }, 500);
      }
      
      await db.insert(schema.drive_files).values({
        id: fileId,
        name: finalFileName,
        type: 'file',
        size: originalSize,
        url: url,
        ownerId: sharedFolder.ownerId,
        parentId: parentId === 'null' || !parentId ? sharedFolder.id : parentId,
        storageType: storageType,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isEncrypted: isEncryptedFile ? 1 : 0
      });
      
      const newFile = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, fileId)).get();
      
      return ctx.json({ success: true, data: newFile });
    });
  }

  private sharedDownload() {
    this.app.get(API.drive.sharedLinkDownload, async (c) => {
      const ctx = new DriveContext(c);
      await ctx.initOptional();
      
      const { db } = ctx;
      const token = ctx.param('token');
      const fileId = ctx.query('id');
      const key = ctx.query('key') as string || '';
      const R2: any = ctx.env.R2;
      const UPLOADS: any = ctx.env.UPLOADS;
      
      let file;
      if (fileId) {
        file = await db.select().from(schema.drive_files)
          .where(eq(schema.drive_files.id, fileId))
          .get();
      } else {
        file = await db.select().from(schema.drive_files)
          .where(eq(schema.drive_files.shareLinkToken, token))
          .get();
      }
      
      if (!file || file.isDeleted === 1) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      // 如果是文件夹，返回文件列表让前端处理
      if (file.type === 'folder') {
        try {
          // 使用栈模拟递归，返回文件URL列表
          const allFiles: Array<{fileId: string, name: string, path: string, size: number, isEncrypted: number, url: string}> = [];
          const stack: Array<{parentId: string, parentPath: string}> = [{ parentId: file.id, parentPath: '' }];
          
          while (stack.length > 0) {
            const { parentId, parentPath } = stack.pop()!;
            const children = await db.select().from(schema.drive_files)
              .where(and(eq(schema.drive_files.parentId, parentId), eq(schema.drive_files.isDeleted, 0)))
              .orderBy(schema.drive_files.type, schema.drive_files.name);
            
            for (const child of children) {
              const childPath = parentPath ? `${parentPath}/${child.name}` : child.name;
              if (child.type === 'folder') {
                stack.push({ parentId: child.id, parentPath: childPath });
              } else if (child.url && child.url.trim() !== '') {
                allFiles.push({
                  fileId: child.id,
                  name: child.name,
                  path: childPath,
                  size: child.size || 0,
                  isEncrypted: child.isEncrypted,
                  url: child.url
                });
              }
            }
          }
          
          return ctx.json({
            success: true, 
            data: {
              folderName: file.name,
              files: allFiles
            }
          });
        } catch (error: any) {
          console.error('获取文件夹内容失败:', error);
          return ctx.json({ success: false, message: '获取文件夹内容失败' }, 500);
        }
      }
      
      // 文件直接下载
      try {
        const data = await downloadFromStorage(file.storageType, file.url, R2, UPLOADS, db);
        const fileName = file.name;
        return new Response(data, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
            ...getCorsHeaders(this.c.env, this.c.req.raw)
          }
        });
      } catch (err: any) {
        console.error('download error:', err);
        return ctx.json({ success: false, message: '文件下载失败' }, 500);
      }
    });
  }

  private sharedRename() {
    this.app.post(API.drive.sharedLinkRename, this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      await ctx.initOptional();
      
      const { db } = ctx;
      const token = ctx.param('token');
      const { id, name } = await ctx.jsonBody<{ id: string; name: string }>().catch(() => ({ id: '', name: '' }));
      
      if (!id || !name || !name.trim()) {
        return ctx.json({ success: false, message: '缺少参数' }, 400);
      }
      
      const sharedFolder = await db.select().from(schema.drive_files)
        .where(eq(schema.drive_files.shareLinkToken, token))
        .get();
      
      if (!sharedFolder) {
        return ctx.json({ success: false, message: '分享链接无效' }, 404);
      }
      
      // 检查文件是否属于这个分享链接的目录
      const file = await db.select().from(schema.drive_files)
        .where(eq(schema.drive_files.id, id))
        .get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      // 检查权限：只有 edit 和 upload 权限可以重命名
      const hasPermission = (perm: string) => perm === 'edit' || perm === 'upload';
      
      // 检查文件是否在分享目录内
      let hasAccess = false;
      if (file.parentId === sharedFolder.id) {
        // 文件直接在分享目录内
        hasAccess = hasPermission(sharedFolder.sharePermission || 'view');
      } else {
        // 检查父目录是否有分享权限
        let parentId = file.parentId;
        while (parentId) {
          const parent = await db.select().from(schema.drive_files)
            .where(eq(schema.drive_files.id, parentId))
            .get();
          if (!parent) break;
          if (parent.shareLinkToken === token && hasPermission(parent.sharePermission || 'view')) {
            hasAccess = true;
            break;
          }
          parentId = parent.parentId;
        }
      }
      
      if (!hasAccess) {
        return ctx.json({ success: false, message: '您没有重命名权限' }, 403);
      }
      
      // 执行重命名
      await db.update(schema.drive_files)
        .set({ name: name.trim(), updatedAt: Date.now() })
        .where(eq(schema.drive_files.id, id));
      
      return ctx.json({ success: true });
    });
  }

  private createFolder() {
    this.app.post(API.drive.createFolder, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const { name, parentId, isEncrypted } = await ctx.jsonBody<any>().catch(() => ({}));
      
      const settings = await loadDriveSettings(db);
      const storageType = settings.storageType || 'r2';
      
      if (!name || !name.trim()) {
        return ctx.json({ success: false, message: '请输入文件夹名称' }, 400);
      }
      
      // 检查是否有同名文件夹
      const existingFolder = await db.select().from(schema.drive_files)
        .where(and(
          eq(schema.drive_files.name, name.trim()),
          eq(schema.drive_files.type, 'folder'),
          eq(schema.drive_files.isDeleted, 0),
          parentId ? eq(schema.drive_files.parentId, parentId) : sql`${schema.drive_files.parentId} IS NULL`
        ))
        .get();
      
      if (existingFolder) {
        return ctx.json({ success: false, message: '该文件夹已存在' }, 400);
      }
      
      const folderId = crypto.randomUUID();
      const finalIsEncrypted = isEncrypted === true || isEncrypted === 'true' ? 1 : 0;
      
      // 继承父文件夹的共享设置
      let parentShareInfo: any = null;
      if (parentId && parentId !== 'null') {
        const parentFile = await db.select().from(schema.drive_files)
          .where(eq(schema.drive_files.id, parentId))
          .get();
        if (parentFile && parentFile.isShared === 1) {
          parentShareInfo = {
            isShared: 1,
            shareFrom: parentFile.ownerId,
            sharePermission: parentFile.sharePermission,
            shareLinkToken: parentFile.shareLinkToken,
            shareToUsers: parentFile.shareToUsers,
            shareToGroups: parentFile.shareToGroups
          };
        }
      }
      
      await db.insert(schema.drive_files).values({
        id: folderId,
        name: name.trim(),
        type: 'folder',
        size: 0,
        url: '',
        ownerId: userId,
        parentId: parentId === 'null' || !parentId ? null : parentId,
        storageType: storageType,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        isEncrypted: finalIsEncrypted,
        ...(parentShareInfo || {})
      });
      
      const folder = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, folderId)).get();
      
      return ctx.json({ success: true, data: folder });
    });
  }

  private deleteFile() {
    this.app.delete(API.drive.delete, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const id = ctx.param('id');
      const now = Date.now();
      
      const file = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, id)).get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      const isOwner = file.ownerId === userId;
      const canEdit = file.isShared === 1 && file.sharePermission === 'edit';
      
      if (!isOwner && !canEdit) {
        return ctx.json({ success: false, message: '没有权限删除（只读权限）' }, 403);
      }
      
      if (file.type === 'folder') {
        const idsToDelete: string[] = [id];
        
        const collectIds = async (parentId: string) => {
          const children = await db.select({ id: schema.drive_files.id, type: schema.drive_files.type })
            .from(schema.drive_files)
            .where(eq(schema.drive_files.parentId, parentId))
            .all();
          for (const child of children) {
            idsToDelete.push(child.id);
            if (child.type === 'folder') {
              await collectIds(child.id);
            }
          }
        };
        await collectIds(id);
        
        await db.update(schema.drive_files)
          .set({ isDeleted: 1, deletedAt: now, updatedAt: now })
          .where(sql`${schema.drive_files.id} IN (${idsToDelete.map(id => `'${id}'`).join(',')})`);
      } else {
        await db.update(schema.drive_files)
          .set({ isDeleted: 1, deletedAt: now, updatedAt: now })
          .where(eq(schema.drive_files.id, id));
      }
      
      return ctx.json({ success: true, message: '文件已移至回收站' });
    });
  }

  private batchDelete() {
    this.app.post(API.drive.batchDelete, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const db = drizzle(c.env.DB);
      const userId = c.get('userId');
      
      const body = await c.req.json().catch(() => ({ ids: [] }));
      const ids: string[] = body?.ids || [];
      
      if (!ids || ids.length === 0) {
        return c.json({ success: false, message: '请选择要删除的文件' }, 400);
      }
      
      const now = Date.now();
      const idsToDelete: string[] = [];
      
      for (const id of ids) {
        const file = await db.select().from(schema.drive_files)
          .where(eq(schema.drive_files.id, id))
          .get();
        
        if (!file) continue;
        
        const isOwner = file.ownerId === userId;
        const canEdit = file.isShared === 1 && file.sharePermission === 'edit';
        
        if (!isOwner && !canEdit) continue;
        
        idsToDelete.push(file.id);
        
        if (file.type === 'folder') {
          const collectIds = async (parentId: string) => {
            const children = await db.select({ id: schema.drive_files.id, type: schema.drive_files.type })
              .from(schema.drive_files)
              .where(eq(schema.drive_files.parentId, parentId))
              .all();
            for (const child of children) {
              idsToDelete.push(child.id);
              if (child.type === 'folder') {
                await collectIds(child.id);
              }
            }
          };
          await collectIds(file.id);
        }
      }
      
      if (idsToDelete.length > 0) {
        for (const id of idsToDelete) {
          await db.update(schema.drive_files)
            .set({ isDeleted: 1, deletedAt: now, updatedAt: now })
            .where(eq(schema.drive_files.id, id));
        }
      }
      
      return c.json({ success: true, message: `已删除 ${idsToDelete.length} 个文件` });
    });

    this.app.delete(API.drive.emptyTrash, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId, env } = ctx;
      
      // 批量查询当前用户已删除的文件
      const files = await db.select()
        .from(schema.drive_files)
        .where(and(
          eq(schema.drive_files.ownerId, userId as string),
          eq(schema.drive_files.isDeleted, 1)
        ))
        .all();
      
      if (files.length === 0) {
        return ctx.json({ success: true, message: '回收站已是空的' });
      }
      
      // 删除存储
      const settings = await loadDriveSettings(db);
      const storageManager = new StorageManager(settings, env.R2 as any, env.UPLOADS as any);
      
      // 逐个删除
      for (const file of files) {
        if (file.type === 'file' && file.url) {
          try { await storageManager.deleteFile(file.url); } catch (e) {}
        }
        await db.delete(schema.drive_files).where(eq(schema.drive_files.id, file.id));
      }
      
      return ctx.json({ success: true, message: `已清空回收站，删除了 ${files.length} 个文件` });
    });

    this.app.post(API.drive.batchPermanentDelete, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId, env } = ctx;
      
      const body = await c.req.json().catch(() => ({ ids: [] }));
      const ids: string[] = body?.ids || [];
      
      if (!ids || ids.length === 0) {
        return ctx.json({ success: false, message: '请选择要删除的文件' }, 400);
      }
      
      // 批量查询
      const validFiles = await db.select()
        .from(schema.drive_files)
        .where(and(
          sql`id IN (${ids.map(id => `'${id}'`).join(',')})`,
          eq(schema.drive_files.ownerId, userId as string),
          eq(schema.drive_files.isDeleted, 1)
        ))
        .all();
      
      if (validFiles.length === 0) {
        return ctx.json({ success: false, message: '没有可删除的文件' }, 400);
      }
      
      // 删除存储
      const settings = await loadDriveSettings(db);
      const storageManager = new StorageManager(settings, env.R2 as any, env.UPLOADS as any);
      
      for (const file of validFiles) {
        if (file.type === 'file' && file.url) {
          try { await storageManager.deleteFile(file.url); } catch (e) {}
        }
      }
      
      // 批量删除
      const deleteIds = validFiles.map(f => f.id);
      for (const id of deleteIds) {
        await db.delete(schema.drive_files).where(eq(schema.drive_files.id, id));
      }
      
      return ctx.json({ success: true, message: `已永久删除 ${validFiles.length} 个文件` });
    });
  }

  private share() {
    this.app.post(API.drive.share, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const id = ctx.param('id');
      const { share, permission = 'view', shareToUsers = [], shareToGroups = [], frontendUrl } = await ctx.jsonBody<any>().catch(() => ({}));
      const isShared = share;
      
      const file = await db.select().from(schema.drive_files)
        .where(and(eq(schema.drive_files.id, id), eq(schema.drive_files.ownerId, userId)))
        .get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      const validPermission = ['view', 'edit', 'upload'].includes(permission) ? permission : 'view';
      
      let shareLinkToken = file.shareLinkToken;
      if (isShared && !shareLinkToken) {
        shareLinkToken = crypto.randomUUID();
      }
      
      const usersJson = JSON.stringify(Array.isArray(shareToUsers) ? shareToUsers : []);
      const groupsJson = JSON.stringify(Array.isArray(shareToGroups) ? shareToGroups : []);
      
      const finalUsersJson = isShared ? usersJson : '[]';
      const finalGroupsJson = isShared ? groupsJson : '[]';
      const finalToken = isShared ? shareLinkToken : null;
      
      await db.update(schema.drive_files)
        .set({
          isShared: isShared ? 1 : 0,
          sharePermission: validPermission,
          shareToUsers: finalUsersJson,
          shareToGroups: finalGroupsJson,
          shareLinkToken: finalToken,
          updatedAt: Date.now()
        })
        .where(eq(schema.drive_files.id, id));
      
      if (file.type === 'folder') {
        const getAllChildIds = async (parentId: string): Promise<string[]> => {
          const children = await db.select({ id: schema.drive_files.id, type: schema.drive_files.type })
            .from(schema.drive_files)
            .where(eq(schema.drive_files.parentId, parentId))
            .all();
          let ids: string[] = [];
          for (const child of children) {
            ids.push(child.id);
            if (child.type === 'folder') {
              const childIds = await getAllChildIds(child.id);
              ids = [...ids, ...childIds];
            }
          }
          return ids;
        };
        
        const allChildIds = await getAllChildIds(id);
        if (allChildIds.length > 0) {
          for (const childId of allChildIds) {
            await db.update(schema.drive_files)
              .set({
                isShared: isShared ? 1 : 0,
                sharePermission: validPermission,
                shareToUsers: finalUsersJson,
                shareToGroups: finalGroupsJson,
                shareLinkToken: finalToken,
                updatedAt: Date.now()
              })
              .where(eq(schema.drive_files.id, childId));
          }
        }
      }
      
      const msg = share 
        ? `已开启共享，权限：${validPermission === 'edit' ? '允许修改' : validPermission === 'upload' ? '允许上传' : '只读'}` 
        : '已关闭共享';
      // 只返回 token，让前端生成完整链接
      const shareLink = share ? shareLinkToken : null;
      
      return ctx.json({ 
        success: true, 
        message: msg,
        shareLink
      });
    });
  }

  private move() {
    this.app.post(API.drive.move, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const id = ctx.param('id');
      const { parentId } = await ctx.jsonBody<any>().catch(() => ({}));
      
      const file = await db.select().from(schema.drive_files)
        .where(and(eq(schema.drive_files.id, id), eq(schema.drive_files.ownerId, userId)))
        .get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      await db.update(schema.drive_files)
        .set({ parentId: parentId === 'null' || !parentId ? null : parentId, updatedAt: Date.now() })
        .where(eq(schema.drive_files.id, id));
      
      return ctx.json({ success: true, message: '文件已移动' });
    });
  }

  private rename() {
    this.app.post(API.drive.rename, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const id = ctx.param('id');
      const { name } = await ctx.jsonBody<any>().catch(() => ({}));
      
      if (!name || !name.trim()) {
        return ctx.json({ success: false, message: '请输入新名称' }, 400);
      }
      
      const file = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, id)).get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      const isOwner = file.ownerId === userId;
      const canEdit = file.isShared === 1 && file.sharePermission === 'edit';
      
      if (!isOwner && !canEdit) {
        return ctx.json({ success: false, message: '没有权限重命名' }, 403);
      }
      
      await db.update(schema.drive_files)
        .set({ name: name.trim(), updatedAt: Date.now() })
        .where(eq(schema.drive_files.id, id));
      
      return ctx.json({ success: true, message: '文件已重命名' });
    });
  }

  private download() {
    this.app.get(API.drive.download, async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const id = ctx.param('id');
      const R2: any = ctx.env.R2;
      const UPLOADS: any = ctx.env.UPLOADS;
      
      // 先查询文件，不加ownerId过滤
      const file = await db.select().from(schema.drive_files)
        .where(eq(schema.drive_files.id, id))
        .get();
      
      if (!file || file.isDeleted === 1) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      // 检查权限：所有者或有下载权限的共享用户（包括群组分享）
      const isOwner = file.ownerId === userId;
      let hasPermission = isOwner;
      
      if (!hasPermission) {
        const shareToUsers = file.shareToUsers ? JSON.parse(file.shareToUsers) : [];
        const shareToGroups = file.shareToGroups ? JSON.parse(file.shareToGroups) : [];
        
        // 检查用户分享
        if (shareToUsers.includes(userId)) {
          hasPermission = true;
        }
        
        // 检查群组分享
        if (!hasPermission && shareToGroups.length > 0) {
          const userGroups = await db.select({ sessionId: schema.session_participants.sessionId })
            .from(schema.session_participants)
            .where(eq(schema.session_participants.userId, userId))
            .all();
          const userGroupIds = userGroups.map(g => g.sessionId);
          
          const hasAllGroups = shareToGroups.includes('__all__');
          const hasGroupShare = hasAllGroups || shareToGroups.some((g: string) => userGroupIds.includes(g));
          
          if (hasGroupShare) {
            hasPermission = true;
          }
        }
      }
      
      if (!hasPermission) {
        return ctx.json({ success: false, message: '没有下载权限' }, 403);
      }
      
      
      // 如果是文件夹，返回文件列表让前端处理
      if (file.type === 'folder') {
        try {
          // 使用栈模拟递归，返回文件URL列表
          const allFiles: Array<{fileId: string, name: string, path: string, size: number, isEncrypted: number, url: string}> = [];
          const stack: Array<{parentId: string, parentPath: string}> = [{ parentId: file.id, parentPath: '' }];
          
          while (stack.length > 0) {
            const { parentId, parentPath } = stack.pop()!;
            const children = await db.select().from(schema.drive_files)
              .where(and(eq(schema.drive_files.parentId, parentId), eq(schema.drive_files.isDeleted, 0)))
              .orderBy(schema.drive_files.type, schema.drive_files.name);
            
            for (const child of children) {
              const childPath = parentPath ? `${parentPath}/${child.name}` : child.name;
              if (child.type === 'folder') {
                stack.push({ parentId: child.id, parentPath: childPath });
              } else if (child.url && child.url.trim() !== '') {
                allFiles.push({
                  fileId: child.id,
                  name: child.name,
                  path: childPath,
                  size: child.size || 0,
                  isEncrypted: child.isEncrypted,
                  url: child.url
                });
              }
            }
          }
          
          return ctx.json({ 
            success: true, 
            data: {
              folderName: file.name,
              files: allFiles
            }
          });
        } catch (error: any) {
          console.error('获取文件夹内容失败:', error);
          return ctx.json({ success: false, message: '获取文件夹内容失败' }, 500);
        }
      }
      
      // 文件直接下载
      try {
        const data = await downloadFromStorage(file.storageType || 'r2', file.url, R2, UPLOADS, db);
        const fileName = file.name;
        const contentDisposition = `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
        
        const headers = new Headers();
        headers.set('Content-Type', 'application/octet-stream');
        headers.set('Content-Disposition', contentDisposition);
        headers.set('Content-Length', data.length.toString());
        
        // 添加 CORS 头
        const corsHeaders = getCorsHeaders(c.env, c.req.raw);
        for (const [key, value] of Object.entries(corsHeaders)) {
          headers.set(key, value);
        }
        
        return new Response(data, { headers });
      } catch (err: any) {
        console.error('文件下载失败:', err);
        return ctx.json({ success: false, message: '文件不存在或下载失败' }, 404);
      }
    });
  }

  private sharedWithMe() {
    this.app.get(API.drive.sharedWithMe, async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db, userId } = ctx;
      const parentId = ctx.query('parentId');
      
      const userGroups = await db.select({ sessionId: schema.session_participants.sessionId })
        .from(schema.session_participants)
        .where(eq(schema.session_participants.userId, userId))
        .all();
      const userGroupIds = userGroups.map(g => g.sessionId);
      
      const allFiles = await db.select().from(schema.drive_files)
        .where(eq(schema.drive_files.isDeleted, 0))
        .all();
      
      
      const sharedFiles = allFiles.filter((file: any) => {
        // 排除自己的文件
        if (file.ownerId === userId) return false;
        
        const shareToUsers = file.shareToUsers ? JSON.parse(file.shareToUsers) : [];
        const shareToGroups = file.shareToGroups ? JSON.parse(file.shareToGroups) : [];
        
        
        
        // 检查用户分享
        const hasUserShare = shareToUsers.includes(userId);
        
        // 检查群组分享（包括分享给所有群组的情况）
        const hasAllGroups = shareToGroups.includes('__all__');
        const hasGroupShare = hasAllGroups || shareToGroups.some((g: string) => userGroupIds.includes(g));
        
        return hasUserShare || hasGroupShare;
      });
      
      let files;
      if (parentId && parentId !== 'null') {
        files = sharedFiles.filter((f: any) => f.parentId === parentId);
      } else {
        files = sharedFiles.filter((f: any) => !f.parentId);
      }
      
      files.sort((a: any, b: any) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'folder' ? -1 : 1;
      });
      
      // 获取所有者的用户名
      const ownerIds = [...new Set(files.map((f: any) => f.ownerId || f.owner_id))];
      
      const owners: Record<string, any> = {};
      if (ownerIds.length > 0) {
        for (const ownerId of ownerIds) {
          if (!ownerId) continue;
          try {
            const owner = await db.select().from(schema.users)
              .where(eq(schema.users.id, ownerId))
              .get();
            
            if (owner) {
              owners[ownerId] = { id: owner.id, name: owner.name, username: owner.username, avatar: owner.avatar };
            }
          } catch (e) {
            console.error('[sharedWithMe] query owner error:', e);
          }
        }
      }
      
      
      
      // 添加 owner 信息到每个文件
      const filesWithOwner = files.map((file: any) => {
        const ownerId = file.ownerId || file.owner_id;
        const owner = owners[ownerId];
        return {
          ...file,
          ownerId: ownerId,
          ownerName: owner?.name || owner?.username || '未知'
        };
      });
      
      
      
      return ctx.json({ success: true, data: filesWithOwner });
    });
  }

  private restore() {
    this.app.post(API.drive.restore, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db } = ctx;
      const id = ctx.param('id');
      
      const file = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, id)).get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      await db.update(schema.drive_files)
        .set({ isDeleted: 0, deletedAt: null, updatedAt: Date.now() })
        .where(eq(schema.drive_files.id, id));
      
      return ctx.json({ success: true, message: '文件已恢复' });
    });
  }
	
  /*
  * 永久删除
  */
  private permanentDelete() {
    this.app.delete(API.drive.permanentDelete, this.authMiddleware(), this.csrfProtection(), async (c) => {
      const ctx = new DriveContext(c);
      const init = await ctx.init();
      if (!init.success) return ctx.json({ success: false, message: init.error }, 401);
      
      const { db } = ctx;
      const id = ctx.param('id');
      const R2: any = ctx.env.R2;
      const UPLOADS: any = ctx.env.UPLOADS;
      
      const settings = await loadDriveSettings(db);
      const storageType = settings.storageType || 'r2';
      
      const file = await db.select().from(schema.drive_files).where(eq(schema.drive_files.id, id)).get();
      
      if (!file) {
        return ctx.json({ success: false, message: '文件不存在' }, 404);
      }
      
      if (file.type === 'folder') {
        const deleteChildren = async (parentId: string) => {
          const children = await db.select({ id: schema.drive_files.id, type: schema.drive_files.type, url: schema.drive_files.url })
            .from(schema.drive_files)
            .where(eq(schema.drive_files.parentId, parentId))
            .all();
          for (const child of children) {
            if (child.type === 'file' && child.url) {
              try {
                await deleteFromStorage(storageType, child.url, R2, UPLOADS, db);
              } catch (e) {}
            } else if (child.type === 'folder') {
              await deleteChildren(child.id);
            }
          }
        };
        await deleteChildren(id);
      }
      
      if (file.type === 'file' && file.url) {
        try {
          await deleteFromStorage(storageType, file.url, R2, UPLOADS, db);
        } catch (e) {}
      }
      
      await db.delete(schema.drive_files).where(eq(schema.drive_files.id, id));
      
      return ctx.json({ success: true, message: '文件已永久删除' });
    });
  }
}

// pCloud API 配置
interface PCloudConfig {
  token: string;
  folderId: string;
}

// Google Drive 配置
interface GoogleDriveConfig {
  token: string;
  folderId: string;
}

export function registerDriveRoutes(app: any) {
  const router = new DriveRouter(app);
  router.register();
}

// ==================== 辅助函数 ====================
// 从数据库中加载网盘设置
async function loadDriveSettings(db: ReturnType<typeof drizzle>): Promise<StorageConfig> {
  try {
    const storageTypeRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'storageType'))
      .get();
    const pcloudRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'pcloud'))
      .get();
    const googleRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'google'))
      .get();
    const pcloudFolderIdsRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'pcloud_folder_ids'))
      .get();
    const googleFolderIdsRow = await db.select({ value: schema.system_settings.value })
      .from(schema.system_settings)
      .where(eq(schema.system_settings.key, 'google_folder_ids'))
      .get();
    
    const settings: StorageConfig = { storageType: 'r2' };
    if (storageTypeRow?.value) settings.storageType = storageTypeRow.value as StorageConfig['storageType'];
    
    if (pcloudRow?.value) {
      try { 
        let parsed: any;
        // 如果是 JSON 字符串，先解析
        if (typeof pcloudRow.value === 'string' && pcloudRow.value.startsWith('{')) {
          parsed = JSON.parse(pcloudRow.value);
        } else {
          parsed = pcloudRow.value;
        }
        // parsed 可能是对象或已经是提取后的值
        if (typeof parsed === 'object' && parsed !== null) {
          // token 可能是普通字符串，也可能是 JSON 字符串
          let tokenValue = parsed.token || '';
          if (typeof tokenValue === 'string' && tokenValue.startsWith('{')) {
            try {
              const tokenParsed = JSON.parse(tokenValue);
              tokenValue = tokenParsed.access_token || tokenParsed.token || '';
            } catch {}
          }
          settings.pcloud = { 
            token: tokenValue, 
            folderId: parsed.folderId || '0' 
          };
        } else {
          // 已经是字符串
          settings.pcloud = { 
            token: String(parsed), 
            folderId: '0' 
          };
        }
      } catch (e) {
        console.error('解析 pcloud 设置失败:', e);
      }
    }
    
    if (googleRow?.value) {
      try { 
        let parsed: any;
        if (typeof googleRow.value === 'string' && googleRow.value.startsWith('{')) {
          parsed = JSON.parse(googleRow.value);
        } else {
          parsed = googleRow.value;
        }
        // token 可能是普通字符串，也可能是 JSON 字符串
        let tokenValue = parsed.token || parsed.access_token || '';
        if (typeof tokenValue === 'string' && tokenValue.startsWith('{')) {
          try {
            const tokenParsed = JSON.parse(tokenValue);
            tokenValue = tokenParsed.access_token || tokenParsed.token || '';
          } catch {}
        }
        settings.google = { 
          token: tokenValue, 
          folderId: parsed.folderId || 'root' 
        };
      } catch {}
    }
    
    if (pcloudFolderIdsRow?.value) {
      try {
        const folderIds = JSON.parse(pcloudFolderIdsRow.value);
        if (settings.pcloud) {
          settings.pcloud.chatFilesFolderId = folderIds.chatFilesFolderId;
          settings.pcloud.chatAvatarFolderId = folderIds.chatAvatarFolderId;
          settings.pcloud.chatBackupFolderId = folderIds.chatBackupFolderId;
          settings.pcloud.driveFilesFolderId = folderIds.driveFilesFolderId;
          settings.pcloud.driveBackupFolderId = folderIds.driveBackupFolderId;
        }
      } catch {}
    }
    
    if (googleFolderIdsRow?.value) {
      try {
        const folderIds = JSON.parse(googleFolderIdsRow.value);
        if (settings.google) {
          settings.google.chatFilesFolderId = folderIds.chatFilesFolderId;
          settings.google.chatAvatarFolderId = folderIds.chatAvatarFolderId;
          settings.google.chatBackupFolderId = folderIds.chatBackupFolderId;
          settings.google.driveFilesFolderId = folderIds.driveFilesFolderId;
          settings.google.driveBackupFolderId = folderIds.driveBackupFolderId;
        }
      } catch {}
    }
    
    return settings;
  } catch (e) {
    console.error('加载网盘设置失败:', e);
  }
  // 默认加载R2
  return { storageType: 'r2' };
}

async function uploadToStorage(storageType: string, key: string, data: Uint8Array, contentType: string, R2: R2Bucket, UPLOADS: KVNamespace, db: ReturnType<typeof drizzle>): Promise<string> {
  const settings = await loadDriveSettings(db);
  const storageManager = new StorageManager(settings, R2, UPLOADS);
  return await storageManager.uploadFile(key, data, contentType);
}

async function downloadFromStorage(storageType: string, key: string, R2: R2Bucket, UPLOADS: KVNamespace, db?: ReturnType<typeof drizzle>): Promise<Uint8Array> {
  if (!key) throw new Error('文件路径为空');
  
  
  
  // 确保 storageType 有值
  const effectiveStorageType = storageType || 'r2';
  
  
  // 默认使用 R2（StorageManager 会根据配置自动选择 pcloud/google）
  
  const settings = await loadDriveSettings(db!);
  const storageManager = new StorageManager({ ...settings, storageType: effectiveStorageType }, R2, UPLOADS);
  const result = await storageManager.downloadFile(key);
  if (!result || !result.data || result.data.length === 0) {
    throw new Error('文件不存在或为空');
  }
  return result.data;
}

async function deleteFromStorage(storageType: string, key: string, R2: R2Bucket, UPLOADS: KVNamespace, db: ReturnType<typeof drizzle>): Promise<boolean> {
  const settings = await loadDriveSettings(db);
  const storageManager = new StorageManager(settings, R2, UPLOADS);
  return await storageManager.deleteFile(key);
}

export default registerDriveRoutes;
