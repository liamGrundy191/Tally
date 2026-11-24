// Every route declares who may call it (section 11), and only logging in, accepting an invite and
// the health check are open to anyone: every other change goes through the login and CSRF checks
// (T4.1); the health check changes nothing (T4.2).
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';

type Mod = object & { module?: object; controllers?: object[] };

/** The controllers of a module and of every module it imports, at any depth. */
function controllersOf(mod: Mod | undefined, seen = new Set<object>()): object[] {
  const m = mod?.module ?? mod;
  if (!m || seen.has(m)) return [];
  seen.add(m);
  const imports = (Reflect.getMetadata('imports', m) ?? []) as Mod[];
  return [
    ...((Reflect.getMetadata('controllers', m) ?? []) as object[]),
    ...(mod?.controllers ?? []),
    ...imports.flatMap((i) => controllersOf(i, seen)),
  ];
}

/** Each route as "METHOD path", with its access level; handlers inherited from a parent too. */
function routes() {
  const found = new Map<string, unknown>();
  for (const c of controllersOf(AppModule) as (new () => object)[]) {
    for (let p = c.prototype as object; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const name of Object.getOwnPropertyNames(p)) {
        const handler = (p as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const route = `${RequestMethod[method]} ${Reflect.getMetadata('path', c)}/${Reflect.getMetadata('path', handler)}`;
        if (!found.has(route)) {
          found.set(
            route,
            Reflect.getMetadata('access', handler) ?? Reflect.getMetadata('access', c),
          );
        }
      }
    }
  }
  return found;
}

describe('routes', () => {
  it('each declare their access; only two changes are public, and the health check', () => {
    const all = routes();
    expect(all.size).toBeGreaterThanOrEqual(25); // every route of section 8 was found
    for (const [route, access] of all) expect(access, route).toBeDefined();
    const open = [...all].filter(([, access]) => access === 'public').map(([route]) => route);
    expect(open.sort()).toEqual(['GET health//', 'POST auth/accept-invite', 'POST auth/login']);
  });
});
