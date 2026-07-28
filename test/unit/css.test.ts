import { describe, it, expect } from 'vitest';
import {
  parseCssColor,
  hexToRgb,
  rgbToHex,
  fontFromStyle,
  letterSpacingFromStyle,
  lineHeightFromStyle,
  textCaseFromStyle,
  textAlignFromStyle,
  parseLinearGradient,
  linearGradientPaint,
} from '../../src/replica/css';

describe('css color parsing', () => {
  it('parses rgb/rgba', () => {
    expect(parseCssColor('rgb(17, 34, 51)')).toMatchObject({ hex: '#112233', a: 1 });
    expect(parseCssColor('rgba(17, 34, 51, 0.5)')?.a).toBe(0.5);
  });
  it('parses hex', () => {
    expect(parseCssColor('#005A88')).toMatchObject({ r: 0, g: 90 / 255, b: 136 / 255, a: 1 });
    expect(parseCssColor('#fff')).toMatchObject({ r: 1, g: 1, b: 1 });
  });
  it('returns null for transparent/invalid', () => {
    expect(parseCssColor('transparent')).toBeNull();
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseCssColor('not-a-color')).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
  });
  it('hex/rgb round-trip', () => {
    expect(rgbToHex(hexToRgb('#1a2b3c'))).toBe('#1a2b3c');
  });
});

describe('font mapping', () => {
  it('maps weights to figma style names', () => {
    expect(fontFromStyle({ fontFamily: 'Inter', fontWeight: '700' })).toEqual({ family: 'Inter', style: 'Bold' });
    expect(fontFromStyle({ fontFamily: 'Inter', fontWeight: 600 })).toEqual({ family: 'Inter', style: 'SemiBold' });
    expect(fontFromStyle({ fontFamily: 'Inter' })).toEqual({ family: 'Inter', style: 'Regular' });
  });
  it('applies family aliases and style overrides (parameterized, not hard-coded)', () => {
    const opts = { familyAliases: { Arial: 'Inter' }, styleOverrides: { Inter: { Medium: 'SemiBold' } } };
    expect(fontFromStyle({ fontFamily: 'Arial', fontWeight: '500' }, opts)).toEqual({ family: 'Inter', style: 'SemiBold' });
  });
  it('letter-spacing / line-height / text-case conversions', () => {
    expect(letterSpacingFromStyle({ letterSpacing: '0.5px' })).toEqual({ unit: 'PIXELS', value: 0.5 });
    expect(letterSpacingFromStyle({ letterSpacing: 'normal' })).toBeUndefined();
    expect(lineHeightFromStyle({ lineHeight: '28px' })).toEqual({ unit: 'PIXELS', value: 28 });
    expect(textCaseFromStyle({ textTransform: 'uppercase' })).toBe('UPPER');
    expect(textCaseFromStyle({ textTransform: 'none' })).toBeUndefined();
    expect(textAlignFromStyle({ textAlign: 'center' })).toBe('CENTER');
  });
});

describe('gradients', () => {
  it('parses css linear-gradient', () => {
    const g = parseLinearGradient('linear-gradient(90deg, #f0f7fc 0%, #ffffff 100%)');
    expect(g?.angle).toBe(90);
    expect(g?.stops).toHaveLength(2);
    expect(g?.stops[0].position).toBe(0);
    expect(g?.stops[1].position).toBe(1);
  });
  it('converts angle into a figma transform', () => {
    const paint = linearGradientPaint([{ position: 0, color: parseCssColor('#000000')! }, { position: 1, color: parseCssColor('#ffffff')! }], 90);
    expect(paint.type).toBe('GRADIENT_LINEAR');
    expect(paint.gradientStops).toHaveLength(2);
    // 90deg css (left→right) → figma angle 0 → cos=1, sin=0
    expect(paint.gradientTransform[0][0]).toBeCloseTo(1, 5);
    expect(paint.gradientTransform[0][1]).toBeCloseTo(0, 5);
  });
  it('returns null for non-gradient strings', () => {
    expect(parseLinearGradient('url("x.png")')).toBeNull();
  });
});
