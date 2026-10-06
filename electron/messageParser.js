/**
 * 消息解析模块
 * 对应原 WinForm 版 ClientPanel.cs 中的统计逻辑。
 * 解析消息中的 pass/fail、组件失败统计，并生成显示文本。
 */

// 标记"最新更新零件"的行前缀（控制字符，避免与真实文本冲突），由渲染层转为红色高亮
const LATEST_MARKER = '\u0001';

// 处理一条消息，返回更新后的显示文本和内部统计状态
class StatsTracker {
  constructor(connectionKey) {
    this.connectionKey = connectionKey;
    this.passCount = 0;
    this.totalCount = 0;
    this.componentFailStats = {}; // 组件名 -> 次数
    this.startTime = null;
    this.hasReceivedData = false;
    this.warningLog = ''; // 连续测试不良 / 站别错误 的累积日志
    this.lastUpdatedComponents = []; // 最近一次消息中更新的失败组件（用于红色高亮）
  }

  /**
   * 处理接收到的消息，返回 { display, flag }
   * flag: 'normal' | 'continuous' | 'station'
   */
  process(message) {
    if (!message) return null;
    const lowerMsg = message.trim().toLowerCase();

    // 连续测试不良：追加累积日志（与原 WinForm 的 _msg 追加行为一致）
    if (lowerMsg.includes('continuetestfailed')) {
      this.warningLog += `[${formatNow()}]:***连续测试不良***\n`;
      return {
        display: this.warningLog,
        flag: 'continuous',
      };
    }

    // 站别错误：追加累积日志
    if (lowerMsg.includes('stationerror')) {
      this.warningLog += `[${formatNow()}]:***站别错误***\n`;
      return {
        display: this.warningLog,
        flag: 'station',
      };
    }

    // 更新统计
    this.updateStatistics(message);

    if (!this.hasReceivedData) {
      this.hasReceivedData = true;
      this.startTime = new Date();
    }

    if (this.hasReceivedData) {
      return { display: this.buildDisplayText(), flag: 'normal' };
    }
    return null;
  }

  updateStatistics(message) {
    const lowerMsg = message.trim().toLowerCase();

    const passMatches = lowerMsg.match(/\bpass\b/g);
    const failMatches = lowerMsg.match(/\bfail\b/g);
    const passCount = passMatches ? passMatches.length : 0;
    const failCount = failMatches ? failMatches.length : 0;

    if (passCount > 0) {
      this.passCount += passCount;
      this.totalCount += passCount;
    }
    if (failCount > 0 && passCount === 0) {
      this.totalCount += failCount;
    }

    // 组件失败统计（跳过纯 pass/fail 的短消息）
    const cleanedMsgCheck = lowerMsg.replace(/\b(pass|fail)\b|\s/g, '');
    if (cleanedMsgCheck.length <= 4) return;

    // 记录本次消息中更新的失败组件（用于红色高亮），每次调用先清空
    this.lastUpdatedComponents = [];

    const rawComponents = message.split(/[, \n\r]+/).filter((s) => s.length > 0);
    for (const rawComp of rawComponents) {
      const cleanComp = rawComp
        .trim()
        .replace(/\b(pass|fail)\b/gi, '')
        .trim();

      if (!cleanComp || cleanComp.length < 3) continue;

      if (this.componentFailStats[cleanComp] !== undefined) {
        this.componentFailStats[cleanComp]++;
      } else {
        this.componentFailStats[cleanComp] = 1;
      }

      // 加入本次更新集合
      if (!this.lastUpdatedComponents.includes(cleanComp)) {
        this.lastUpdatedComponents.push(cleanComp);
      }
    }
  }

  buildDisplayText() {
    const fpy = this.totalCount === 0 ? 0 : (this.passCount / this.totalCount) * 100;
    const startTimeStr = this.hasReceivedData
      ? formatTime(this.startTime)
      : '--';

    let lines = [];
    lines.push(`--- 连接: ${this.connectionKey} ---`);
    lines.push(`开始时间: ${startTimeStr}`);
    lines.push(`Total : ${this.totalCount}`);
    lines.push(`Pass  : ${this.passCount}`);
    lines.push(`Fail  : ${this.totalCount - this.passCount}`);
    lines.push(`FPY   : ${fpy.toFixed(2)}%`);
    lines.push('------------------------');
    lines.push('Top Failed Components:');

    const entries = Object.entries(this.componentFailStats).sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );

    if (entries.length === 0) {
      lines.push('  (无失败记录)');
    } else {
      for (const [name, count] of entries) {
        // 本次刚更新的组件用控制字符前缀标记，由渲染层显示为红色
        const isLatest = this.lastUpdatedComponents.includes(name);
        const prefix = isLatest ? LATEST_MARKER : '';
        lines.push(`${prefix}  ${name.padEnd(24)} : ${count} 次`);
      }
    }

    return lines.join('\n');
  }

  reset() {
    this.passCount = 0;
    this.totalCount = 0;
    this.componentFailStats = {};
    this.hasReceivedData = false;
    this.startTime = null;
    this.warningLog = '';
    this.lastUpdatedComponents = [];
  }

  // 序列化当前统计状态（用于本地持久化，重开应用后恢复）
  toJSON() {
    return {
      connectionKey: this.connectionKey,
      passCount: this.passCount,
      totalCount: this.totalCount,
      componentFailStats: this.componentFailStats,
      startTime: this.startTime ? this.startTime.toISOString() : null,
      hasReceivedData: this.hasReceivedData,
      warningLog: this.warningLog,
      lastUpdatedComponents: this.lastUpdatedComponents,
    };
  }

  // 从持久化数据恢复统计状态，保证收到新数据时在旧数据基础上累加
  static fromJSON(data) {
    const tracker = new StatsTracker(data.connectionKey);
    tracker.passCount = data.passCount || 0;
    tracker.totalCount = data.totalCount || 0;
    tracker.componentFailStats = data.componentFailStats || {};
    tracker.startTime = data.startTime ? new Date(data.startTime) : null;
    tracker.hasReceivedData = !!data.hasReceivedData;
    tracker.warningLog = data.warningLog || '';
    tracker.lastUpdatedComponents = Array.isArray(data.lastUpdatedComponents)
      ? data.lastUpdatedComponents
      : [];
    return tracker;
  }
}

function formatNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = { StatsTracker };
