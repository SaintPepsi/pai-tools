import type { LanguageProfile } from './types.ts';

// ─── Language Profiles ──────────────────────────────────────────────────────

export const LANGUAGE_PROFILES: LanguageProfile[] = [
	{
		name: 'TypeScript',
		extensions: ['.ts', '.tsx'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*export\s+(default\s+)?(function|class|const|let|var|interface|type|enum|abstract)/gm,
		functionPattern: /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(|^\s*(public|private|protected|static|async)\s+(async\s+)?\w+\s*\(/gm,
		classPattern: /^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s+\w+/gm,
		importPattern: /^\s*import\s+/gm,
	},
	{
		name: 'JavaScript',
		extensions: ['.js', '.jsx', '.mjs', '.cjs'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*(export\s+(default\s+)?|module\.exports)/gm,
		functionPattern: /^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/gm,
		classPattern: /^\s*(export\s+)?(default\s+)?class\s+\w+/gm,
		importPattern: /^\s*(import\s+|const\s+\w+\s*=\s*require\()/gm,
	},
	{
		name: 'Python',
		extensions: ['.py'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^[a-zA-Z_]\w*\s*=/gm,  // Python: top-level assignments as "exports"
		functionPattern: /^\s*(async\s+)?def\s+\w+/gm,
		classPattern: /^\s*class\s+\w+/gm,
		importPattern: /^\s*(import\s+|from\s+\S+\s+import)/gm,
	},
	{
		name: 'Go',
		extensions: ['.go'],
		softThreshold: 300,
		hardThreshold: 600,
		exportPattern: /^func\s+[A-Z]|^type\s+[A-Z]|^var\s+[A-Z]/gm,
		functionPattern: /^func\s+/gm,
		classPattern: /^type\s+\w+\s+struct/gm,
		importPattern: /^\s*"[^"]+"/gm,
	},
	{
		name: 'Rust',
		extensions: ['.rs'],
		softThreshold: 300,
		hardThreshold: 600,
		exportPattern: /^\s*pub\s+(fn|struct|enum|trait|type|mod|const|static)/gm,
		functionPattern: /^\s*(pub\s+)?(async\s+)?fn\s+\w+/gm,
		classPattern: /^\s*(pub\s+)?(struct|enum|trait)\s+\w+/gm,
		importPattern: /^\s*use\s+/gm,
	},
	{
		name: 'Java',
		extensions: ['.java'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^\s*public\s+(class|interface|enum|record)/gm,
		functionPattern: /^\s*(public|private|protected|static|\s)+[\w<>\[\]]+\s+\w+\s*\(/gm,
		classPattern: /^\s*(public\s+)?(abstract\s+)?(class|interface|enum|record)\s+\w+/gm,
		importPattern: /^\s*import\s+/gm,
	},
	{
		name: 'C#',
		extensions: ['.cs'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^\s*public\s+(class|interface|enum|struct|record)/gm,
		functionPattern: /^\s*(public|private|protected|internal|static|async|virtual|override|\s)+[\w<>\[\]]+\s+\w+\s*\(/gm,
		classPattern: /^\s*(public\s+)?(abstract\s+|static\s+)?(class|interface|enum|struct|record)\s+\w+/gm,
		importPattern: /^\s*using\s+/gm,
	},
	{
		name: 'Ruby',
		extensions: ['.rb'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*(def\s+self\.|module_function|attr_)/gm,
		functionPattern: /^\s*def\s+\w+/gm,
		classPattern: /^\s*(class|module)\s+\w+/gm,
		importPattern: /^\s*require\s+/gm,
	},
	{
		name: 'PHP',
		extensions: ['.php'],
		softThreshold: 200,
		hardThreshold: 400,
		exportPattern: /^\s*public\s+(function|static)/gm,
		functionPattern: /^\s*(public|private|protected|static|\s)*function\s+\w+/gm,
		classPattern: /^\s*(abstract\s+)?(class|interface|trait|enum)\s+\w+/gm,
		importPattern: /^\s*(use\s+|require|include)/gm,
	},
	{
		name: 'Swift',
		extensions: ['.swift'],
		softThreshold: 250,
		hardThreshold: 500,
		exportPattern: /^\s*(public|open)\s+(func|class|struct|enum|protocol)/gm,
		functionPattern: /^\s*(public\s+|private\s+|internal\s+|open\s+|static\s+|override\s+)*func\s+\w+/gm,
		classPattern: /^\s*(public\s+|open\s+)?(class|struct|enum|protocol|actor)\s+\w+/gm,
		importPattern: /^\s*import\s+/gm,
	},
];

export const DEFAULT_PROFILE: LanguageProfile = {
	name: 'Unknown',
	extensions: [],
	softThreshold: 250,
	hardThreshold: 500,
	exportPattern: /^\s*export\s+/gm,
	functionPattern: /^\s*(function|def|func|fn)\s+\w+/gm,
	classPattern: /^\s*(class|struct|interface)\s+\w+/gm,
	importPattern: /^\s*(import|require|use|include)\s+/gm,
};

export const SOURCE_EXTENSIONS = new Set(
	LANGUAGE_PROFILES.flatMap(p => p.extensions)
);
