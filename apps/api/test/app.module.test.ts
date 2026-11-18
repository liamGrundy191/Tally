import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

@Injectable()
class Dependency {
  readonly name = 'dependency';
}

@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}

@Module({ providers: [Dependency, Consumer] })
class InjectionModule {}

describe('AppModule', () => {
  it('compiles', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('injects constructor dependencies by type (needs decorator metadata in tests)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [InjectionModule] }).compile();
    expect(moduleRef.get(Consumer).dependency.name).toBe('dependency');
    await moduleRef.close();
  });
});
