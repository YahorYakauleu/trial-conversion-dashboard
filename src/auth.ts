import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Config, Role } from './config.js';

const COOKIE = 'bd_session';
const SESSION_SECONDS = 30 * 86_400;

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const same = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));
// Куда вернуть после входа: только путь этого же сайта (не //evil.com)
const safeNext = (next: unknown) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');

// Вход по логину и паролю → роль. Сессия — подписанная cookie «роль.срок.подпись»; ключ подписи выводится
// из логинов и паролей, поэтому смена любого из них разлогинивает всех. Заголовок Basic тоже принимается —
// для скриптов и curl.
export function createAuth(users: Config['users']) {
  const secret = sha256(JSON.stringify(['session', users.admin, users.guest]));
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

  const check = (user: string, password: string): Role | null => {
    if (same(`${user}:${password}`, `${users.admin.user}:${users.admin.password}`)) return 'admin';
    if (users.guest && same(`${user}:${password}`, `${users.guest.user}:${users.guest.password}`)) return 'guest';
    return null;
  };

  const sessionRole = (req: Request): Role | null => {
    const raw = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const [role, expires, signature] = raw?.split('.') ?? [];
    if (role !== 'admin' && role !== 'guest') return null;
    if (!signature || !same(signature, sign(`${role}.${expires}`)) || Number(expires) < Date.now() / 1000) return null;
    // гостевой вход могли отключить — его сессии больше не действуют
    return role === 'guest' && !users.guest ? null : role;
  };

  const basicRole = (req: Request): Role | null => {
    const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Basic' || !encoded) return null;
    const decoded = Buffer.from(encoded, 'base64').toString();
    const i = decoded.indexOf(':');
    return i < 0 ? null : check(decoded.slice(0, i), decoded.slice(i + 1));
  };

  const roleOf = (req: Request) => sessionRole(req) ?? basicRole(req);

  // Форма входа; уже вошедшего — сразу туда, куда он шёл
  const loginPage =
    (file: string): RequestHandler =>
    (req, res) => {
      if (roleOf(req)) res.redirect(303, safeNext(req.query.next));
      else res.sendFile(file);
    };

  const login: RequestHandler = (req, res) => {
    const role = check(String(req.body?.user ?? ''), String(req.body?.password ?? ''));
    const next = safeNext(req.body?.next);
    if (!role) {
      res.redirect(303, `/login?error=1&next=${encodeURIComponent(next)}`);
      return;
    }
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    res.cookie(COOKIE, `${role}.${expires}.${sign(`${role}.${expires}`)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure, // за прокси Render — https (app.set('trust proxy'))
      maxAge: SESSION_SECONDS * 1000,
      path: '/',
    });
    res.redirect(303, next);
  };

  const logout: RequestHandler = (_req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/login');
  };

  // Без входа: API отвечает 401, страницы ведут на форму входа — с возвратом на ту же ссылку
  const requireLogin: RequestHandler = (req, res, next) => {
    const role = roleOf(req);
    if (role) {
      res.locals.role = role;
      next();
    } else if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Нужен вход' });
    } else {
      res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
  };

  const requireAdmin: RequestHandler = (_req, res, next) => {
    if (res.locals.role === 'admin') next();
    else res.status(403).json({ error: 'Только для админа' });
  };

  return { roleOf, loginPage, login, logout, requireLogin, requireAdmin };
}
