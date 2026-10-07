import Config from '@/config/config';

export async function agentRequest<T>(token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${Config.apiServer}/agent${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}），请检查登录状态或重试`);
  if (!data) throw new Error('服务返回内容无效，请重试');
  return data as T;
}
