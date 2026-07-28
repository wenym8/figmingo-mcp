import { describe, it, expect } from 'vitest';
import { parseFigmaUrl, normalizeNodeId, encodeNodeId, isFigmaUrl } from '../../src/figma/urls';

describe('figma url parsing', () => {
  it('parses design urls with node-id', () => {
    const p = parseFigmaUrl('https://www.figma.com/design/abcDEF12345/My-File?node-id=1-2&m=dev');
    expect(p.fileKey).toBe('abcDEF12345');
    expect(p.nodeId).toBe('1:2');
    expect(p.kind).toBe('design');
  });

  it('parses legacy /file/ urls', () => {
    const p = parseFigmaUrl('https://www.figma.com/file/XYZ987/Thing?node-id=10-20');
    expect(p.fileKey).toBe('XYZ987');
    expect(p.nodeId).toBe('10:20');
    expect(p.kind).toBe('file');
  });

  it('parses proto urls without node-id', () => {
    const p = parseFigmaUrl('https://www.figma.com/proto/keykeykey/Prototype');
    expect(p.fileKey).toBe('keykeykey');
    expect(p.nodeId).toBeUndefined();
  });

  it('handles encoded node ids', () => {
    const p = parseFigmaUrl('https://www.figma.com/design/k/N?node-id=1%3A2');
    expect(p.nodeId).toBe('1:2');
  });

  it('accepts bare file keys', () => {
    expect(parseFigmaUrl('abcDEF1234567').fileKey).toBe('abcDEF1234567');
  });

  it('rejects non-figma urls', () => {
    expect(parseFigmaUrl('https://example.com/design/abc/x').fileKey).toBeUndefined();
  });

  it('node id round-trips', () => {
    expect(normalizeNodeId('1-2')).toBe('1:2');
    expect(normalizeNodeId('1:2')).toBe('1:2');
    expect(encodeNodeId('1:2')).toBe('1-2');
  });

  it('isFigmaUrl', () => {
    expect(isFigmaUrl('https://www.figma.com/design/abc/x')).toBe(true);
    expect(isFigmaUrl('not a url')).toBe(false);
  });
});
