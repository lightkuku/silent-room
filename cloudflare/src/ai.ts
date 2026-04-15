/**
 * AI 处理模块 - 独立文件
 * 支持：文本对话、代码生成、图像识别
 */

import { Context } from 'hono';

// AI 模型配置
const AI_MODELS = {
  // 通用智能对话
  general: '@cf/qwen/qwen3-30b-a3b-fp8',
  // 代码生成
  code: '@cf/qwen/qwen2.5-coder-32b-instruct',
  // 推理思考
  reasoning: '@cf/qwen/qwq-32b',
  // 深度思考
  deep: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
  // 图像识别
  vision: '@cf/meta/llama-3.1-llama-3.2-90b-vision-instruct'
};

// 根据问题类型选择模型
export const selectModel = (userMessage: string): string => {
  const msg = userMessage.toLowerCase();
  
  // 代码相关
  if (/^(write|code|program|function|class|def |const |let |var |import |export |python|javascript|typescript|java|c\+\+|php|ruby|swift|kotlin|sql|html|css|api|algorithm)/i.test(msg) ||
      /代码|编程|函数|算法|程序|开发|前端|后端|react|vue|node|sql|数据库|接口/.test(msg)) {
    return AI_MODELS.code;
  }
  
  // 数学和推理
  if (/^(calculate|compute|solve|math|proof|logic|prove|derivative|integral|equation)/i.test(msg) ||
      /数学|计算|推理|证明|方程|微积分|概率|逻辑|求解/.test(msg)) {
    return AI_MODELS.reasoning;
  }
  
  // 复杂/深度问题
  if (/^(explain|analyze|compare|difference|why|how|what is the best|should i|which is better)/i.test(msg) ||
      /解释|分析|比较|区别|为什么|如何|哪个最好|应该|原理|详细介绍/.test(msg)) {
    return AI_MODELS.deep;
  }
  
  // 默认使用通用模型
  return AI_MODELS.general;
};

// 解析 AI 响应
export const parseAIResponse = (result: any): string => {
  let responseText = '';
  
  // 格式1: result.choices[0].message.content (OpenAI 格式)
  if (result.choices && result.choices[0]?.message?.content) {
    responseText = result.choices[0].message.content;
  }
  // 格式2: result.result.response
  else if (result.result?.response) {
    responseText = result.result.response;
  }
  // 格式3: result.response
  else if (result.response) {
    responseText = result.response;
  }
  // 格式4: result.result
  else if (result.result) {
    responseText = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
  }
  
  // 清理响应文本
  if (responseText) {
    responseText = responseText.trim();
    
    // 如果响应看起来像完整的 JSON（包含 id, object, choices 等字段），提取 content
    if (responseText.startsWith('{') && responseText.includes('"choices"')) {
      try {
        const parsed = JSON.parse(responseText);
        if (parsed.choices && parsed.choices[0]?.message?.content) {
          responseText = parsed.choices[0].message.content.trim();
        }
      } catch (e) {
        // 解析失败，保持原样
      }
    }
  }
  
  if (!responseText) {
    console.error('[AI] 无法解析响应:', JSON.stringify(result).substring(0, 500));
    throw new Error('AI 响应解析失败');
  }
  
  return responseText;
};

// 调用 AI 模型（文本）
export const callAIModel = async (
  accountId: string, 
  token: string, 
  model: string, 
  messages: any[], 
  maxTokens: number = 4096
): Promise<string> => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature: 0.7
      })
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AI] API 错误:', response.status, errorText);
    throw new Error(`AI 模型调用失败: ${response.status}`);
  }
  
  const result = await response.json();
  return parseAIResponse(result);
};

// 调用 AI 图像识别模型
export const callAIVisionModel = async (
  accountId: string,
  token: string,
  imageUrl: string,
  question: string = "请详细描述这张图片的内容，并给出相关问题的解决方案。"
): Promise<string> => {
  const visionModel = AI_MODELS.vision;
  
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: question },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }
  ];
  
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${visionModel}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        max_tokens: 4096,
        temperature: 0.7
      })
    }
  );
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error('[AI Vision] API 错误:', response.status, errorText);
    throw new Error(`AI 图像识别失败: ${response.status}`);
  }
  
  const result = await response.json();
  return parseAIResponse(result);
};

// 检查消息是否包含图片
export const hasImageInMessage = (message: any): boolean => {
  if (!message) return false;
  
  // 检查 attachments 中是否有图片
  if (message.attachments && Array.isArray(message.attachments)) {
    return message.attachments.some((att: any) => 
      att.type === 'image' || att.url?.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)/i)
    );
  }
  
  // 检查 content 中是否有图片 URL
  if (message.content && typeof message.content === 'string') {
    return message.content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp|svg)/i) !== null;
  }
  
  return false;
};

// 从消息中提取图片 URL
export const extractImageUrls = (message: any): string[] => {
  const urls: string[] = [];
  
  if (!message) return urls;
  
  // 从 attachments 提取
  if (message.attachments && Array.isArray(message.attachments)) {
    message.attachments.forEach((att: any) => {
      if (att.type === 'image' && att.url) {
        urls.push(att.url);
      }
    });
  }
  
  // 从 content 提取
  if (message.content && typeof message.content === 'string') {
    const matches = message.content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|bmp|svg)/gi);
    if (matches) {
      urls.push(...matches);
    }
  }
  
  return urls;
};
