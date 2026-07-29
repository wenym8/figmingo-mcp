import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from '../../src/server';

describe('server instructions (MCP initialize handshake)', () => {
  it('exists and mentions the core workflows', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(100);
    expect(SERVER_INSTRUCTIONS).toContain('get_metadata');
    expect(SERVER_INSTRUCTIONS).toContain('get_design_context');
    expect(SERVER_INSTRUCTIONS).toContain('verify_html_parity');
    expect(SERVER_INSTRUCTIONS).toContain('import_html_replica');
    expect(SERVER_INSTRUCTIONS).toContain('bridge_status');
    expect(SERVER_INSTRUCTIONS).toContain('execute_plugin_command');
  });

  it('version is semver and matches the package line format', () => {
    expect(SERVER_NAME).toBe('figmingo-mcp');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
