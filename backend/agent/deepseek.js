export async function chatCompletion(messages, { tools, signal, json = false, maxTokens = 4096 } = {}) {
  if (!process.env.DEEPSEEK_API_KEY?.trim())
    throw Object.assign(new Error('后端尚未配置模型密钥'), { code: 'notConfigured' });
  const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  let url;
  try {
    url = new URL(baseUrl.replace(/\/$/, '') + '/chat/completions');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error();
  } catch {
    throw Object.assign(new Error('后端模型接口地址配置无效'), { code: 'notConfigured' });
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([AbortSignal.timeout(60000), ...(signal ? [signal] : [])]),
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages,
        max_tokens: maxTokens,
        ...(url.hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      }),
    });
    if (!response.ok)
      throw Object.assign(new Error('模型调用失败，请检查后端配置、网络和账户额度'), { code: 'providerFailed' });
    const data = await response.json();
    const usage = {};
    for (const field of [
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'prompt_cache_hit_tokens',
      'prompt_cache_miss_tokens',
    ]) {
      const value = data.usage?.[field];
      if (Number.isSafeInteger(value) && value >= 0) usage[field] = value;
    }
    const recordedUsage = Object.keys(usage).length ? usage : null;
    const choice = data.choices?.[0];
    if (!choice?.message || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
      throw Object.assign(new Error('模型返回内容不完整或格式无效'), { code: 'invalidResponse', usage: recordedUsage });
    }
    return { ...choice, usage: recordedUsage };
  } catch (error) {
    if (error.code && ['notConfigured', 'providerFailed', 'invalidResponse'].includes(error.code)) throw error;
    if (['TimeoutError', 'AbortError'].includes(error.name))
      throw Object.assign(new Error('模型调用超时或任务已结束'), { code: 'timeout' });
    throw Object.assign(new Error('模型连接失败，请检查后端网络和接口配置'), { code: 'providerFailed' });
  }
}
