import type { AgentEntry, CatalogEntry, SkillEntry } from "./types";

export type CatalogMap = Map<string, CatalogEntry>;

function addKey(map: CatalogMap, key: string, entry: CatalogEntry) {
  if (key && !map.has(key.toLowerCase())) {
    map.set(key.toLowerCase(), entry);
  }
}

export function buildAgentAliasMap(agents: AgentEntry[]): CatalogMap {
  const map: CatalogMap = new Map();
  for (const agent of agents) {
    addKey(map, agent.slug, agent);
    addKey(map, agent.name, agent);
    // Plugin agents: also index as "pluginname:slug" and "pluginname:name"
    if (agent.pluginName) {
      addKey(map, `${agent.pluginName}:${agent.slug}`, agent);
      addKey(map, `${agent.pluginName}:${agent.name}`, agent);
    }
  }
  return map;
}

export function buildSkillAliasMap(skills: SkillEntry[]): CatalogMap {
  const map: CatalogMap = new Map();
  for (const skill of skills) {
    addKey(map, skill.slug, skill);
    addKey(map, skill.name, skill);
    if (skill.pluginName) {
      addKey(map, `${skill.pluginName}:${skill.slug}`, skill);
      addKey(map, `${skill.pluginName}:${skill.name}`, skill);
    }
  }
  return map;
}

export function lookupEntry(map: CatalogMap, name: string): CatalogEntry | undefined {
  return map.get(name.toLowerCase());
}
