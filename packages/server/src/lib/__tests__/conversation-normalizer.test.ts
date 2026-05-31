import { describe, it, expect, vi } from 'vitest';

// Mock config to avoid API_KEY requirement
vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'silent',
  },
}));

import {
  autoDetectFormat,
  normalizeConversation,
} from '../conversation-normalizer.js';

describe('conversation-normalizer', () => {
  describe('autoDetectFormat', () => {
    it('should detect claude-code JSONL', () => {
      const input = '{"type":"human","message":"hello"}\n{"type":"assistant","message":"hi"}';
      expect(autoDetectFormat(input)).toBe('claude-code');
    });

    it('should detect codex format', () => {
      const input = '{"event_msg":{"role":"user","content":"hello"}}';
      expect(autoDetectFormat(input)).toBe('codex');
    });

    it('should detect chatgpt format', () => {
      const input = JSON.stringify([{ mapping: { 'a': { parent: null } } }]);
      expect(autoDetectFormat(input)).toBe('chatgpt');
    });

    it('should detect claude-ai format', () => {
      const input = JSON.stringify({ chat_messages: [{ sender: 'human', text: 'hi' }] });
      expect(autoDetectFormat(input)).toBe('claude-ai');
    });

    it('should detect slack format', () => {
      const input = JSON.stringify([{ bot_id: 'B123', text: 'hi' }]);
      expect(autoDetectFormat(input)).toBe('slack');
    });

    it('should detect plain text with > markers', () => {
      expect(autoDetectFormat('> hello\nworld')).toBe('plain');
    });

    it('should default to plain for unrecognized content', () => {
      expect(autoDetectFormat('just some regular text here')).toBe('plain');
    });
  });

  describe('claude-code format', () => {
    it('should parse JSONL with type:human/assistant pairs', () => {
      const input = [
        '{"type":"human","message":"What is TypeScript?"}',
        '{"type":"assistant","message":"TypeScript is a typed superset of JS."}',
      ].join('\n');

      const exchanges = normalizeConversation(input, 'claude-code');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toBe('What is TypeScript?');
      expect(exchanges[0].assistantMessage).toBe('TypeScript is a typed superset of JS.');
      expect(exchanges[0].source).toBe('claude-code');
    });

    it('should return empty array for malformed input', () => {
      expect(normalizeConversation('not json at all', 'claude-code')).toEqual([]);
    });
  });

  describe('codex format', () => {
    it('should parse JSONL with event_msg role-based messages', () => {
      const input = [
        '{"session_meta":{"id":"sess-1"}}',
        '{"event_msg":{"role":"user","content":"Hello"}}',
        '{"event_msg":{"role":"assistant","content":"Hi there"}}',
      ].join('\n');

      const exchanges = normalizeConversation(input, 'codex');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toBe('Hello');
      expect(exchanges[0].assistantMessage).toBe('Hi there');
      expect(exchanges[0].source).toBe('codex');
      expect(exchanges[0].sessionId).toBe('sess-1');
    });
  });

  describe('claude-ai format', () => {
    it('should parse JSON with chat_messages array', () => {
      const input = JSON.stringify({
        chat_messages: [
          { sender: 'human', text: 'What is TypeScript?' },
          { sender: 'assistant', text: 'TypeScript is a typed superset of JavaScript.' },
        ],
      });

      const exchanges = normalizeConversation(input, 'claude-ai');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toBe('What is TypeScript?');
      expect(exchanges[0].assistantMessage).toBe('TypeScript is a typed superset of JavaScript.');
      expect(exchanges[0].source).toBe('claude-ai');
    });

    it('should parse array of direct sender messages', () => {
      const input = JSON.stringify([
        { sender: 'human', text: 'Hello' },
        { sender: 'assistant', text: 'Hi' },
      ]);

      const exchanges = normalizeConversation(input, 'claude-ai');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toBe('Hello');
      expect(exchanges[0].assistantMessage).toBe('Hi');
    });

    it('should return empty array for malformed input', () => {
      expect(normalizeConversation('not json', 'claude-ai')).toEqual([]);
    });
  });

  describe('chatgpt format', () => {
    it('should parse conversations.json with mapping tree', () => {
      const input = JSON.stringify([{
        mapping: {
          'root': {
            parent: null,
            children: ['node-user'],
            message: null,
          },
          'node-user': {
            parent: 'root',
            children: ['node-assistant'],
            message: {
              author: { role: 'user' },
              content: { parts: ['Hello, how are you?'] },
              create_time: 1700000000,
            },
          },
          'node-assistant': {
            parent: 'node-user',
            children: [],
            message: {
              author: { role: 'assistant' },
              content: { parts: ['I am doing well, thank you!'] },
              create_time: 1700000001,
            },
          },
        },
      }]);

      const exchanges = normalizeConversation(input, 'chatgpt');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toBe('Hello, how are you?');
      expect(exchanges[0].assistantMessage).toBe('I am doing well, thank you!');
      expect(exchanges[0].source).toBe('chatgpt');
      expect(exchanges[0].timestamp).toBeDefined();
    });

    it('should return empty array for malformed input', () => {
      expect(normalizeConversation('not json', 'chatgpt')).toEqual([]);
      expect(normalizeConversation('{}', 'chatgpt')).toEqual([]);
    });
  });

  describe('slack format', () => {
    it('should parse Slack JSON with user and bot messages', () => {
      const input = JSON.stringify([
        { user: 'U123', text: 'Hey team', ts: '1700000000.000100' },
        { bot_id: 'B456', text: 'Hello! How can I help?', ts: '1700000001.000200' },
      ]);

      const exchanges = normalizeConversation(input, 'slack');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toBe('Hey team');
      expect(exchanges[0].assistantMessage).toBe('Hello! How can I help?');
      expect(exchanges[0].source).toBe('slack');
    });

    it('should return empty array for malformed input', () => {
      expect(normalizeConversation('not json', 'slack')).toEqual([]);
    });
  });

  describe('plain format', () => {
    it('should parse lines starting with > as user turns', () => {
      const input = `> How do I use TypeScript?
The easiest way is to install it via npm.
You can then compile .ts files using tsc.`;

      const exchanges = normalizeConversation(input, 'plain');
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].userMessage).toContain('How do I use TypeScript?');
      expect(exchanges[0].assistantMessage).toContain('install it via npm');
      expect(exchanges[0].source).toBe('plain');
    });

    it('should handle multiple exchanges', () => {
      const input = `> First question
First answer
> Second question
Second answer`;

      const exchanges = normalizeConversation(input, 'plain');
      expect(exchanges).toHaveLength(2);
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty input', () => {
      expect(normalizeConversation('')).toEqual([]);
    });

    it('should return empty array for null-ish input', () => {
      expect(normalizeConversation(null as unknown as string)).toEqual([]);
    });

    it('should return empty array for unknown format', () => {
      expect(normalizeConversation('hello', 'nonexistent-format')).toEqual([]);
    });
  });
});
