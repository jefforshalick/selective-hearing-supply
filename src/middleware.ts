import { defineMiddleware } from 'astro:middleware';
import { isValidToken, COOKIE_NAME } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  // Protect all /admin routes except the login page itself
  if (pathname.startsWith('/admin') && pathname !== '/admin/login') {
    const token = context.cookies.get(COOKIE_NAME)?.value;
    if (!token || !(await isValidToken(token))) {
      return context.redirect('/admin/login');
    }
  }

  return next();
});
