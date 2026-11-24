// Every route declares who may call it (section 11), and only logging in and accepting an invite
// are open to anyone: every other change goes through the login and CSRF checks (T4.1).
import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.ts';

describe('routes', () => {
  it('each declare their access, and only two are public, both POST', () => {
    const open: string[] = [];
    for (const c of Reflect.getMetadata('controllers', AppModule) as (new () => object)[]) {
      for (const name of Object.getOwnPropertyNames(c.prototype)) {
        const handler = (c.prototype as Record<string, object>)[name]!;
        const method = Reflect.getMetadata('method', handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const route = `${RequestMethod[method]} ${Reflect.getMetadata('path', c)}/${Reflect.getMetadata('path', handler)}`;
        const access = Reflect.getMetadata('access', handler) ?? Reflect.getMetadata('access', c);
        expect(access, route).toBeDefined();
        if (access === 'public') open.push(route);
      }
    }
    expect(open.sort()).toEqual(['POST auth/accept-invite', 'POST auth/login']);
  });
});
