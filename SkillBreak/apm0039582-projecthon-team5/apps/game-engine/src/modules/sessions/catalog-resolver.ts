import { Injectable } from '@nestjs/common';
import { CatalogRepository } from '../script-catalog/catalog.repository';
import type { ComponentTemplateDto } from '../script-catalog/catalog.types';
import type { ResolvedScript } from './core/state';

@Injectable()
export class CatalogResolver {
  private readonly cache = new Map<string, ResolvedScript>();
  constructor(private readonly catalog: CatalogRepository) {}

  async bySlug(slug: string): Promise<ResolvedScript | undefined> {
    const current = await this.catalog.current(slug);
    return current ? this.version(current.scriptId, current.version) : undefined;
  }
  async version(scriptId: string, version: number): Promise<ResolvedScript | undefined> {
    const cacheKey = JSON.stringify([scriptId, version]);
    const cached = this.cache.get(cacheKey);
    if (cached) return structuredClone(cached);
    const script = await this.catalog.script(scriptId, version);
    if (!script) return undefined;
    const templates: Record<string, ComponentTemplateDto> = {};
    const keys = new Set<string>();
    for (const state of script.states) {
      for (const puzzle of state.puzzles) {
        if (keys.has(puzzle.key)) throw new Error('Puzzle keys must be unique within a script');
        keys.add(puzzle.key);
        const delimiter = puzzle.templateRef.lastIndexOf('@');
        const templateVersion = Number(puzzle.templateRef.slice(delimiter + 1));
        if (delimiter < 1 || !Number.isSafeInteger(templateVersion) || templateVersion < 1) throw new Error('Invalid template reference');
        const template = await this.catalog.template(puzzle.templateRef.slice(0, delimiter), templateVersion);
        if (!template) throw new Error('Missing published template');
        templates[puzzle.templateRef] = template;
      }
    }
    const content = { script, templates };
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(cacheKey, structuredClone(content));
    return content;
  }
}