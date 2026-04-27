import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  JIRA_DOMAIN,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  JIRA_PROJECT_KEY = '',
  DATA_JSON_PATH = '../data.json',
  POLL_INTERVAL_MINUTES = '5',
} = process.env;

function validateEnv() {
  const missing = ['JIRA_DOMAIN', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`[ENV] 미설정 환경변수: ${missing.join(', ')}`);
}

function buildAuthHeader() {
  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  return `Basic ${token}`;
}

// Jira 이슈 목록 조회 (assignee = currentUser, Done 제외)
async function fetchAssignedIssues() {
  const url = `https://${JIRA_DOMAIN}/rest/api/3/search/jql`;
  const projectFilter = JIRA_PROJECT_KEY ? `project = ${JIRA_PROJECT_KEY} AND ` : '';
  const jql = `${projectFilter}assignee = currentUser() AND status != Done ORDER BY updated DESC`;
  const fields = 'summary,status,duedate,description,assignee,priority,created,updated';

  const res = await axios.get(url, {
    params: { jql, fields, maxResults: 100 },
    headers: {
      Authorization: buildAuthHeader(),
      Accept: 'application/json',
    },
    timeout: 15000,
  });

  return res.data.issues || [];
}

// summary에서 client 추출: "[46263/우리금융캐피탈]" → "우리금융캐피탈", "[한국항공우주산업/1429]" → "한국항공우주산업"
function extractClient(summary) {
  const match = summary.match(/\[([^\]]+)\]/);
  if (!match) return '';
  const inner = match[1];
  const parts = inner.split('/');
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].trim();
    // 마지막 부분이 순수 숫자면 첫 번째 부분이 클라이언트명
    return /^\d+$/.test(last) ? parts[0].trim() : last;
  }
  return inner.trim();
}

// Jira status → 대시보드 status 매핑
function mapStatus(jiraStatus) {
  const lower = jiraStatus.toLowerCase();
  if (lower.includes('done') || lower.includes('완료') || lower.includes('resolved')) return '완료';
  if (lower.includes('progress') || lower.includes('진행') || lower.includes('검토')) return '진행중';
  if (lower.includes('todo') || lower.includes('open') || lower.includes('대기') || lower.includes('해야')) return '대기';
  return '진행중';
}

// description에서 첫 200자만 추출 (복잡한 ADF 구조 방어)
function extractDescription(description) {
  if (!description) return '';
  if (typeof description === 'string') return description.slice(0, 200);
  // Atlassian Document Format (ADF) 처리
  try {
    const texts = [];
    const walk = (node) => {
      if (node.type === 'text' && node.text) texts.push(node.text);
      if (node.content) node.content.forEach(walk);
    };
    walk(description);
    return texts.join(' ').slice(0, 200);
  } catch {
    return '';
  }
}

function readDataJson() {
  const p = path.resolve(__dirname, DATA_JSON_PATH);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function todayKST() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeDataJson(data) {
  const p = path.resolve(__dirname, DATA_JSON_PATH);
  data.lastUpdated = todayKST();
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

// 기존 항목에서 Jira 키 매칭 (notes에 "LZIJ-XXXX" 또는 "JIRA:XXXX" 포함)
function findExistingByKey(projects, key) {
  return projects.find(p => p.notes && p.notes.includes(key));
}

function nextId(projects) {
  const ids = projects.map(p => p.id).filter(id => typeof id === 'number' && !isNaN(id));
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function issueToProject(issue, existingId) {
  const { key, fields } = issue;
  const summary = fields.summary || '';
  const desc = extractDescription(fields.description);
  const today = todayKST();

  return {
    id: existingId,
    title: summary,
    client: extractClient(summary),
    category: '제안',
    tags: ['제안서'],
    status: mapStatus(fields.status?.name || ''),
    priority: 1,
    deadline: fields.duedate || '',
    weeklyUpdate: false,
    owner: null,
    progress: `${today}: Jira 자동 동기화 (${key})`,
    nextPlan: '',
    notes: `${key}. ${desc}`.trim(),
  };
}

async function sync() {
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[SYNC] ${ts} 동기화 시작`);

  let issues;
  try {
    issues = await fetchAssignedIssues();
  } catch (err) {
    console.error(`[ERROR] Jira API 호출 실패: ${err.message}`);
    return;
  }

  console.log(`[SYNC] 조회된 이슈: ${issues.length}건`);

  const data = readDataJson();
  let added = 0, updated = 0;

  for (const issue of issues) {
    const existing = findExistingByKey(data.projects, issue.key);
    if (existing) {
      // 기존 항목 업데이트 (status, deadline, notes만)
      const mapped = issueToProject(issue, existing.id);
      existing.status = mapped.status;
      existing.deadline = mapped.deadline || existing.deadline;
      const today = mapped.progress.split(':')[0];
      if (!existing.progress.includes(issue.key)) {
        existing.progress += `\n${today}: Jira 자동 동기화 (${issue.key})`;
      }
      updated++;
    } else {
      // 신규 항목 추가
      const newProject = issueToProject(issue, nextId(data.projects));
      data.projects.push(newProject);
      added++;
    }
  }

  writeDataJson(data);
  console.log(`[SYNC] 완료 — 신규: ${added}건, 업데이트: ${updated}건`);
}

async function main() {
  validateEnv();

  const onceMode = process.argv.includes('--once');
  if (onceMode) {
    await sync();
    return;
  }

  console.log(`[INIT] Jira 동기화 시작 — ${JIRA_DOMAIN} (${POLL_INTERVAL_MINUTES}분 폴링)`);
  await sync();

  const interval = parseInt(POLL_INTERVAL_MINUTES, 10);
  cron.schedule(`*/${interval} * * * *`, sync);
  console.log(`[INIT] 크론 등록 완료: ${interval}분 주기`);
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
