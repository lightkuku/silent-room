// 举报相关常量

export interface ReportReason {
  value: string;
  label: string;
}

export const REPORT_REASONS: ReportReason[] = [
  { value: 'spam', label: '垃圾广告' },
  { value: 'harassment', label: '骚扰辱骂' },
  { value: 'fraud', label: '欺诈诈骗' },
  { value: 'privacy', label: '涉及敏感内容' },
  { value: 'other', label: '其他违规' },
];

export const REPORT_REASON_MAP: Record<string, string> = {
  spam: '垃圾广告',
  harassment: '骚扰辱骂',
  fraud: '欺诈诈骗',
  privacy: '涉及敏感内容',
  other: '其他违规',
};

export function getReportReasonLabel(value: string): string {
  return REPORT_REASON_MAP[value] || value;
}
