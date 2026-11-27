import { describe, it, expect } from 'vitest';
import { siteBranding, brandedFrom, cleanName, oklchToHex } from '../../src/branding.js';

describe('siteBranding', () => {
  it('reads name, hue and icon from the site config', () => {
    const b = siteBranding(
      { info: { title: 'Parroquia San Miguel' }, theme: { accentHue: 30, icon: 'https://data.parroquia.app/x/icon.png' } },
      'x',
    );
    expect(b.name).toBe('Parroquia San Miguel');
    expect(b.color).toBe(oklchToHex(0.52, 0.17, 30));
    expect(b.iconUrl).toBe('https://data.parroquia.app/x/icon.png');
  });

  it('falls back to the slug as a title, the default hue and no icon', () => {
    const b = siteBranding(null, 'san-miguel-arcangel');
    expect(b.name).toBe('San Miguel Arcangel');
    expect(b.color).toBe(oklchToHex(0.52, 0.17, 200));
    expect(b.iconUrl).toBeNull();
  });

  it('normalises the hue and ignores unusable icons (http, svg, junk)', () => {
    expect(siteBranding({ theme: { accentHue: 390 } }, 'x').color).toBe(oklchToHex(0.52, 0.17, 30));
    expect(siteBranding({ theme: { accentHue: -30 } }, 'x').color).toBe(oklchToHex(0.52, 0.17, 330));
    for (const icon of ['http://a.b/i.png', 'https://a.b/i.svg', 'icon.png', 42]) {
      expect(siteBranding({ theme: { icon } }, 'x').iconUrl).toBeNull();
    }
    expect(siteBranding({ icon: ['https://a.b/i.webp'] }, 'x').iconUrl).toBe('https://a.b/i.webp');
  });
});

describe('brandedFrom', () => {
  it('puts the site name on the configured sending address', () => {
    expect(brandedFrom({}, { name: 'Demo' })).toBe('Demo <no-reply@parroquia.app>');
    expect(brandedFrom({ FROM_EMAIL: 'Parroquia App <hola@example.org>' }, { name: 'Demo' })).toBe('Demo <hola@example.org>');
    expect(brandedFrom({ FROM_EMAIL: 'hola@example.org' }, { name: 'Demo' })).toBe('Demo <hola@example.org>');
  });

  it('strips header-injection and address syntax from the name', () => {
    expect(cleanName('San <Pedro>, "Oeste"\r\nBcc: x@y.z')).toBe('San Pedro Oeste Bcc xy.z');
    expect(brandedFrom({}, { name: '<>' })).toBe('Parroquia App <no-reply@parroquia.app>');
  });
});
