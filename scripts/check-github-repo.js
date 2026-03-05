const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 匹配 GitHub 仓库链接的正则（适配 [xxx](https://github.com/xxx/xxx) 和纯链接）
const GITHUB_LINK_REGEX = /\[.*?\]\((https:\/\/github\.com\/[\w-]+\/[\w-]+(?:\/tree\/[\w-]+\/[\w-]+)?)\)/g;
const RAW_GITHUB_REGEX = /https:\/\/github\.com\/[\w-]+\/[\w-]+(?:\/tree\/[\w-]+\/[\w-]+)?/g;

/**
 * 归一化仓库链接（修复路径解析，正确拼接用户名/仓库名）
 * @param {string} url 原始链接
 * @returns { { normalized: string, raw: string } } 归一化后的链接 + 原始链接
 */
function normalizeRepoUrl(url) {
  try {
    const urlObj = new URL(url);
    // 拆分路径并过滤空字符串（解决双斜杠导致的空元素问题）
    const pathParts = urlObj.pathname.split('/').filter((part) => part.trim() !== '');

    // 必须满足 用户名/仓库名 两级路径（排除作者主页）
    if (pathParts.length >= 2) {
      const [owner, repo] = pathParts; // 第一级是用户名，第二级是仓库名
      // 正确拼接：避免双斜杠，严格拼接 用户名/仓库名.git
      const normalizedUrl = `https://github.com/${owner}/${repo}.git`;
      return {
        normalized: normalizedUrl,
        raw: url,
      };
    }
    return { normalized: null, raw: url };
  } catch (err) {
    return { normalized: null, raw: url };
  }
}

/**
 * 执行 git ls-remote 检查仓库可达性（适配 403/仓库禁用场景）
 * @param {string} url 仓库链接
 * @returns { { accessible: boolean, rawUrl: string, message: string } }
 */
function checkRepoAccessibility(url) {
  const { normalized, raw } = normalizeRepoUrl(url);

  // 链接格式不合法
  if (!normalized) {
    return {
      accessible: false,
      rawUrl: raw,
      message: '❌ 链接格式不合法，无法解析',
    };
  }

  try {
    // 执行 git ls-remote，静默模式（--quiet），超时 10 秒
    const output = execSync(`git ls-remote --quiet ${normalized}`, {
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'], // 捕获 stdout/stderr
    })
      .toString()
      .trim();

    // 正常情况：git ls-remote 返回 refs 信息（非空），或空（部分公共仓库也可能返回空但可访问）
    return {
      accessible: true,
      rawUrl: raw,
      message: `✅ 仓库可正常访问 ${output ? '- 引用信息：' + output.substring(0, 50) + '...' : ''}`,
    };
  } catch (err) {
    let errorMsg = '未知错误';
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    const stdout = err.stdout ? err.stdout.toString().trim() : '';

    // 1. 超时场景
    if (err.status === null) {
      errorMsg = '❌ 检查超时（10秒）';
    }
    // 2. GitHub 禁用仓库（匹配你提供的 "Access to this repository has been disabled"）
    else if (stderr.includes('Access to this repository has been disabled')) {
      errorMsg = '❌ 仓库已被 GitHub 官方禁用（403 Forbidden）';
    }
    // 3. 403 权限错误（通用）
    else if (
      stderr.includes('403') ||
      (stderr.includes('fatal: unable to access') && stderr.includes('The requested URL returned error: 403'))
    ) {
      errorMsg = '❌ 403 Forbidden - 无访问权限/仓库被限制';
    }
    // 4. 其他错误（如仓库不存在、网络问题）
    else if (stderr) {
      // 截取 stderr 前 120 个字符，保留关键信息
      errorMsg = `❌ 访问失败: ${stderr.substring(0, 120)}`;
    } else if (stdout) {
      errorMsg = `❌ 访问失败: ${stdout.substring(0, 120)}`;
    } else {
      errorMsg = `❌ 访问失败（退出码：${err.status}）`;
    }

    return {
      accessible: false,
      rawUrl: raw,
      message: errorMsg,
    };
  }
}

/**
 * 从 README.md 提取所有 GitHub 仓库链接（去重）
 * @param {string} filePath README.md 路径
 * @returns {string[]} 去重后的仓库链接列表
 */
function extractGithubRepos(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.error(`❌ 错误：未找到文件 ${filePath}`);
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const markdownLinks = [];
    const rawLinks = [];

    // 匹配 Markdown 链接格式 [xxx](https://github.com/xxx/xxx)
    let match;
    while ((match = GITHUB_LINK_REGEX.exec(content)) !== null) {
      markdownLinks.push(match[1].trim());
    }

    // 匹配纯 GitHub 链接（兜底）
    while ((match = RAW_GITHUB_REGEX.exec(content)) !== null) {
      rawLinks.push(match[0].trim());
    }

    // 合并并去重
    const allLinks = [...new Set([...markdownLinks, ...rawLinks])];
    // 过滤空链接
    return allLinks.filter((link) => link);
  } catch (err) {
    console.error(`❌ 读取文件异常：${err.message}`);
    return [];
  }
}
const cleanError = (str) => {
  return str
    .split('\n')
    .filter((line) => !line.trim().startsWith('fatal:')) // 过滤 fatal: 行
    .join(' ')
    .trim()
    .substring(0, 120); // 限制长度，避免信息过长
};

// 主执行逻辑
function main() {
  const readmePath = path.join(process.cwd(), 'README.md');
  console.log('🔍 开始检查 README.md 中的 GitHub 仓库链接...\n');

  // 提取仓库链接
  const repos = extractGithubRepos(readmePath);
  if (repos.length === 0) {
    console.log('ℹ️ 未提取到任何 GitHub 仓库链接');
    process.exit(0);
  }

  // 遍历检查每个仓库
  repos.forEach((repo) => {
    const result = checkRepoAccessibility(repo);
    const errorMessage = cleanError(result.message);
    console.log(`${errorMessage} | 原始地址：${result.rawUrl}`);
  });
}

// 启动脚本
main();
