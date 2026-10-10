import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT_LEARNINGS,
  MemorializedKnowledgeEntry,
  SEED_MEMORIALIZED_KNOWLEDGE,
  renderAgentLearningsMarkdown,
} from '../shared/agentLearnings.js';
import { MacBridgeHub, macBridgeHub } from './macBridgeHub.js';

const LOCAL_MAC_DIR = path.join(os.homedir(), '.cloud-skills-lab-runner');
const TMP_SNAPSHOT_DIR = '/tmp/skills-runner-snapshots';

function getPrimaryStoragePath(): string {
  try {
    if (process.platform === 'darwin') {
      fs.mkdirSync(LOCAL_MAC_DIR, { recursive: true });
      return path.join(LOCAL_MAC_DIR, 'knowledge_base.json');
    }
  } catch {
    // Fallback to /tmp
  }
  fs.mkdirSync(TMP_SNAPSHOT_DIR, { recursive: true });
  return path.join(TMP_SNAPSHOT_DIR, 'knowledge_base.json');
}

const knowledgeById = new Map<string, MemorializedKnowledgeEntry>();

function initKnowledgeStore() {
  for (const seed of SEED_MEMORIALIZED_KNOWLEDGE) {
    knowledgeById.set(seed.id, seed);
  }
  const candidatePaths = [
    path.join(LOCAL_MAC_DIR, 'knowledge_base.json'),
    path.join(TMP_SNAPSHOT_DIR, 'knowledge_base.json'),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list: MemorializedKnowledgeEntry[] = Array.isArray(raw)
          ? raw
          : Array.isArray(raw?.entries)
          ? raw.entries
          : [];
        for (const item of list) {
          if (item && item.id) {
            knowledgeById.set(item.id, item);
          }
        }
      }
    } catch {
      // Ignore corrupt file
    }
  }
}

initKnowledgeStore();

function persistToLocalDisk(): MemorializedKnowledgeEntry[] {
  const all = getAllMemorializedKnowledge();
  try {
    const targetPath = getPrimaryStoragePath();
    fs.writeFileSync(
      targetPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), entries: all }, null, 2),
      'utf8'
    );
    const md = renderAgentLearningsMarkdown(all);
    const mdPath = path.join(path.dirname(targetPath), 'AGENT_LEARNINGS.md');
    fs.writeFileSync(mdPath, md, 'utf8');
    const repoMdPath = path.resolve(process.cwd(), 'AGENT_LEARNINGS.md');
    if (fs.existsSync(path.dirname(repoMdPath))) {
      fs.writeFileSync(repoMdPath, md, 'utf8');
    }
  } catch {
    // Ignore read-only filesystem errors in container
  }
  return all;
}

export function getAllMemorializedKnowledge(): MemorializedKnowledgeEntry[] {
  return Array.from(knowledgeById.values()).sort((a, b) =>
    String(b.timestamp || '').localeCompare(String(a.timestamp || ''))
  );
}

export function slugifyKnowledgeId(prefix: string, titleA: string, titleB = ''): string {
  const raw = `${prefix}-${titleA}-${titleB}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return raw || `${prefix}-${Date.now()}`;
}

export async function syncKnowledgeWithBridge(explicitHub?: MacBridgeHub): Promise<MemorializedKnowledgeEntry[]> {
  const hub = explicitHub || macBridgeHub;
  if (!hub.isConnected()) {
    return getAllMemorializedKnowledge();
  }
  try {
    const res = await hub.call<{ ok?: boolean; entries?: MemorializedKnowledgeEntry[] }>(
      'get_learning_entries',
      {},
      6000
    );
    if (Array.isArray(res?.entries)) {
      let addedOrUpdated = false;
      for (const item of res.entries) {
        if (item && item.id) {
          const prev = knowledgeById.get(item.id);
          if (!prev || (item.timestamp || '') >= (prev.timestamp || '')) {
            knowledgeById.set(item.id, item);
            addedOrUpdated = true;
          }
        }
      }
      if (addedOrUpdated) {
        persistToLocalDisk();
      }
    }
    // Also push our merged entries + rendered Markdown back to the Mac Bridge so the user's Mac is always complete
    const all = getAllMemorializedKnowledge();
    const markdown = renderAgentLearningsMarkdown(all);
    await hub
      .call(
        'save_learning_entry',
        {
          entries: all,
          markdown,
        },
        8000
      )
      .catch(() => {});
  } catch {
    // Non-fatal if bridge does not support RPC yet or timed out
  }
  return getAllMemorializedKnowledge();
}

export async function recordMemorializedKnowledge(
  entry: MemorializedKnowledgeEntry,
  explicitHub?: MacBridgeHub
): Promise<MemorializedKnowledgeEntry> {
  const normalized: MemorializedKnowledgeEntry = {
    ...entry,
    id:
      entry.id ||
      slugifyKnowledgeId(entry.stream, entry.courseOrLabTitle, entry.moduleOrTaskTitle),
    timestamp: entry.timestamp || new Date().toISOString(),
    conceptsAndCapabilities: Array.isArray(entry.conceptsAndCapabilities)
      ? entry.conceptsAndCapabilities
      : [],
    agentRulesAndTakeaways: Array.isArray(entry.agentRulesAndTakeaways)
      ? entry.agentRulesAndTakeaways
      : [],
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  };

  // If merging quizQa with an existing quiz_mastery entry for the same quiz, union the questions
  const existing = knowledgeById.get(normalized.id);
  if (
    existing &&
    normalized.stream === 'quiz_mastery' &&
    Array.isArray(existing.quizQa) &&
    Array.isArray(normalized.quizQa)
  ) {
    const qaMap = new Map<string, any>();
    for (const q of existing.quizQa) {
      if (q?.question) qaMap.set(q.question.trim(), q);
    }
    for (const q of normalized.quizQa) {
      if (q?.question) qaMap.set(q.question.trim(), q);
    }
    normalized.quizQa = Array.from(qaMap.values());
  }

  knowledgeById.set(normalized.id, normalized);
  const all = persistToLocalDisk();
  const markdown = renderAgentLearningsMarkdown(all);

  const hub = explicitHub || macBridgeHub;
  if (hub.isConnected()) {
    await hub
      .call(
        'save_learning_entry',
        {
          entry: normalized,
          entries: all,
          markdown,
        },
        8000
      )
      .catch(() => {});
  }

  return normalized;
}

/**
 * Retrieves the most relevant accumulated course, quiz, lab, and engineering learnings
 * for a given task/quiz context so Gemini can apply prior learnings automatically.
 */
export function retrieveRelevantKnowledgeForPrompt(
  queryContext: string,
  maxEntries = 5
): string {
  const lower = (queryContext || '').toLowerCase();
  const words = Array.from(
    new Set(
      lower
        .replace(/[^a-z0-9_-]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !['task', 'step', 'click', 'google', 'cloud', 'with', 'from', 'that', 'this', 'your'].includes(w))
    )
  );

  if (words.length === 0) return '';

  const allEntries = getAllMemorializedKnowledge();
  const scored = allEntries
    .map((entry) => {
      const hay = [
        entry.courseOrLabTitle,
        entry.moduleOrTaskTitle,
        entry.summary,
        ...(entry.tags || []),
        ...(entry.conceptsAndCapabilities || []),
        ...(entry.agentRulesAndTakeaways || []),
      ]
        .join(' ')
        .toLowerCase();

      let score = 0;
      for (const w of words) {
        if (hay.includes(w)) score += 1;
      }
      for (const tag of entry.tags || []) {
        if (lower.includes(tag.toLowerCase())) score += 3;
      }
      if (lower.includes(entry.courseOrLabTitle.toLowerCase())) {
        score += 5;
      }
      return { entry, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEntries);

  if (scored.length === 0) return '';

  const blocks: string[] = [];
  for (const { entry } of scored) {
    const lines: string[] = [
      `- **[${entry.stream.toUpperCase()}] ${entry.courseOrLabTitle} — ${entry.moduleOrTaskTitle}**: ${entry.summary}`,
    ];
    for (const rule of (entry.agentRulesAndTakeaways || []).slice(0, 3)) {
      lines.push(`  - Rule/Takeaway: ${rule}`);
    }
    if (entry.labRecipe?.selfHealingDelta) {
      lines.push(`  - Self-Healing Note: ${entry.labRecipe.selfHealingDelta}`);
    }
    if (entry.quizQa?.length) {
      for (const qa of entry.quizQa.slice(0, 2)) {
        lines.push(
          `  - Verified Quiz Q&A: "${qa.question}" -> ${qa.verifiedAnswers.join(' + ')} (${qa.domainRule || qa.explanation})`
        );
      }
    }
    blocks.push(lines.join('\n'));
  }

  return `### PRIOR MEMORIALIZED COURSE, QUIZ & LAB KNOWLEDGE\n${blocks.join('\n')}`;
}

export { AGENT_LEARNINGS, renderAgentLearningsMarkdown };
