// Crowdin 送來的 PR（l10n_crowdin）由 CI 替安全字記下「照哪一版原文翻的」（safety.hashes.json），
// 並產生一則 PR 留言讓作者逐字對照（docs/superpowers/specs/2026-11-18-crowdin-translation-design.md §4）。
// 這個檔會被 `npm run i18n:export` 複製進公開翻譯 repo 的 scripts/，只能引用 node 內建與同目錄的 rules.mjs：
// stamp.yml 帶著寫入 token，從 main 取這兩個檔來跑，不 npm ci、不執行 PR 裡的程式碼。
// 用法（翻譯 repo 根目錄、PR head 的工作目錄）：node <腳本> --base origin/main --out comment.md [--check-scope]
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { crowdinScopeErrors, hashString, isLocaleDirName } from './rules.mjs';

/** @typedef {Record<string, string>} Flat */

/**
 * Crowdin 的 commit 訊息（「New translations safety.json (English)」）。Crowdin 的 GitHub 整合用作者自己的帳號（OAuth）提交，
 * 作者名稱認不出來，只能靠訊息；只看還沒合進 main 的 commit（`<base>..HEAD`），已合併的舊 commit 不算。
 */
export const CROWDIN_COMMIT_MESSAGE = '^New translations ';

/**
 * 只替這次改到的安全字 stamp；原文在 Crowdin 寫入譯文之後又改過的先不 stamp（held），等 Crowdin 重新同步。
 * @param {{ source: Flat; sourceAtTranslation: Flat; base: Flat; head: Flat; stamps: Flat }} args
 * @returns {{ stamps: Flat; stamped: string[]; held: string[] }}
 */
export const planCrowdinStamps = ({
	source,
	sourceAtTranslation,
	base,
	head,
	stamps,
}) => {
	/** @type {Flat} */
	const out = {};
	/** @type {string[]} */
	const stamped = [];
	/** @type {string[]} */
	const held = [];
	// 照譯文檔的順序（跟 validate.mjs --stamp 一樣），不排序：不然每個 Crowdin PR 都會重排整個 safety.hashes.json
	for (const key of Object.keys(head)) {
		const value = head[key];
		const changed = value.trim() !== '' && value !== base[key];
		if (!changed) {
			if (Object.hasOwn(stamps, key)) out[key] = stamps[key];
			continue;
		}
		if (
			Object.hasOwn(source, key) &&
			sourceAtTranslation[key] === source[key]
		) {
			out[key] = hashString(source[key]);
			stamped.push(key);
		} else held.push(key);
	}
	return { stamps: out, stamped, held };
};

/** 留言裡逐字顯示譯文：HTML 跳脫後放進 <code>，譯文裡的 HTML／Markdown 不會改變它看起來的樣子 */
const cell = (/** @type {string | undefined} */ s) =>
	`<code>${(s ?? '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('|', '&#124;')
		.replaceAll('`', '&#96;')
		.replaceAll('\n', ' ')}</code>`;

/**
 * PR 留言：這次 stamp 的安全字「中文原文／譯文」並列；held 的另列一節。
 * @param {{ locale: string; source: Flat; head: Flat; stamped: string[]; held: string[] }} args
 */
export const stampComment = ({ locale, source, head, stamped, held }) => {
	const lines = [`### ${locale}`, ''];
	if (stamped.length) {
		lines.push(
			'這裡的記錄只代表「你核准時看到的中文原文是這一版」，不保證譯者照這版翻；請逐字對照中文原文與譯文。',
			'',
			'| 鍵 | 中文原文 | 譯文 |',
			'| --- | --- | --- |',
		);
		for (const k of stamped)
			lines.push(`| \`${k}\` | ${cell(source[k])} | ${cell(head[k])} |`);
		lines.push('');
	}
	if (held.length) {
		lines.push(
			'中文原文在 Crowdin 寫入譯文之後改過，先不記錄，等 Crowdin 重新同步後會再跑一次：',
			'',
			...held.map((k) => `- \`${k}\``),
			'',
		);
	}
	if (!stamped.length && !held.length)
		lines.push('這次沒有改到安全相關的字。', '');
	return lines.join('\n');
};

/** 攤平成一層（非字串的葉子略過，validate 會另外報錯） */
const flatten = (/** @type {unknown} */ tree) => {
	/** @type {Flat} */
	const flat = {};
	const walk = (/** @type {unknown} */ node, /** @type {string} */ path) => {
		if (typeof node === 'string') flat[path] = node;
		else if (node && typeof node === 'object' && !Array.isArray(node))
			for (const [k, v] of Object.entries(node))
				walk(v, path ? `${path}.${k}` : k);
	};
	walk(tree, '');
	return flat;
};

const git = (/** @type {string[]} */ args) =>
	execFileSync('git', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});

/** 某個 ref 的檔案內容（攤平）；不存在就是空的 */
const flatAt = (/** @type {string} */ ref, /** @type {string} */ path) => {
	try {
		return flatten(JSON.parse(git(['show', `${ref}:${path}`])));
	} catch {
		return {};
	}
};

const flatFile = (/** @type {string} */ path) =>
	existsSync(path) ? flatten(JSON.parse(readFileSync(path, 'utf8'))) : {};

const main = (/** @type {string} */ baseRef, /** @type {string} */ outFile) => {
	const source = flatAt(baseRef, 'messages/zh-TW/safety.json');
	const comments = ['## 安全相關的字（請逐字對照後再核准）', ''];
	for (const locale of readdirSync('messages').sort()) {
		if (locale === 'zh-TW' || !isLocaleDirName(locale)) continue;
		const safetyPath = `messages/${locale}/safety.json`;
		const hashesPath = `messages/${locale}/safety.hashes.json`;
		const lastCrowdin = git([
			'log',
			'-1',
			'--format=%H',
			`--grep=${CROWDIN_COMMIT_MESSAGE}`,
			`${baseRef}..HEAD`,
			'--',
			safetyPath,
		]).trim();
		// 找不到 Crowdin 的 commit（作者名稱對不上、或不是 Crowdin 寫的）就全部先不記錄：寧可擋下也不放行
		const sourceAtTranslation = lastCrowdin
			? flatAt(lastCrowdin, 'messages/zh-TW/safety.json')
			: {};
		const head = flatFile(safetyPath);
		const before = flatFile(hashesPath);
		const plan = planCrowdinStamps({
			source,
			sourceAtTranslation,
			base: flatAt(baseRef, safetyPath),
			head,
			stamps: before,
		});
		if (JSON.stringify(plan.stamps) !== JSON.stringify(before))
			writeFileSync(hashesPath, `${JSON.stringify(plan.stamps, null, '\t')}\n`);
		comments.push(
			stampComment({
				locale,
				source,
				head,
				stamped: plan.stamped,
				held: plan.held,
			}),
		);
		console.log(
			`${locale}：記錄 ${plan.stamped.length} 則、等同步 ${plan.held.length} 則`,
		);
	}
	writeFileSync(outFile, comments.join('\n'));
};

// 直接執行時才跑；比對真實路徑（macOS 的 /var 是 /private/var 的捷徑，不展開就永遠不相等、什麼都不做）
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	const arg = (/** @type {string} */ name) => {
		const i = process.argv.indexOf(name);
		return i === -1 ? undefined : process.argv[i + 1];
	};
	const baseRef = arg('--base');
	const outFile = arg('--out');
	if (!baseRef || !outFile) {
		console.error(
			'用法：node scripts/crowdin-stamp.mjs --base origin/main --out comment.md',
		);
		process.exit(2);
	}
	if (process.argv.includes('--check-scope')) {
		// 改到訊息檔以外的 PR 不 stamp（validate 也會擋）；--no-renames：改檔名要列出兩邊的路徑
		const bad = crowdinScopeErrors(
			git(['diff', '--no-renames', '--name-only', `${baseRef}...HEAD`])
				.split('\n')
				.filter(Boolean),
		);
		if (bad.length) {
			writeFileSync(
				join(process.cwd(), outFile),
				`## 沒有記錄安全字\n\n這個 PR 改到訊息檔以外的路徑，不是 Crowdin 該送的內容：\n\n${bad.map((p) => `- <code>${p.replaceAll('<', '&lt;')}</code>`).join('\n')}\n`,
			);
			console.error(`✗ 範圍外的路徑：${bad.join('、')}`);
			process.exit(1);
		}
	}
	main(baseRef, join(process.cwd(), outFile));
}
