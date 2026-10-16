import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { SlidersHorizontal } from 'lucide-react';
import { DrawerSettingsPanel } from '../../client/src/components/ui/settings-panel';

// This panel's only hook supplies DOM IDs. Keep it deterministic so the native
// button handlers can also be exercised directly without a browser dependency.
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  let nextId = 0;
  return { ...actual, useId: () => `EXAMPLE-panel-${nextId++}` };
});

const props = {
  id: 'range', title: 'Range', icon: SlidersHorizontal,
  expandedPanel: 'range', setExpandedPanel: vi.fn(),
  testId: 'EXAMPLE-panel-toggle', children: createElement('input', { id: 'EXAMPLE-field' }),
};

describe('shared drawer settings panels', () => {
  it('opens the clicked panel and closes the current panel using a native button', () => {
    const change = vi.fn();
    const open = DrawerSettingsPanel({ ...props, setExpandedPanel: change });
    const button = open.props.children[0];
    expect(button.type).toBe('button'); expect(button.props.type).toBe('button');
    expect(button.props['aria-expanded']).toBe(true);
    button.props.onClick(); expect(change).toHaveBeenLastCalledWith(null);
    const closed = DrawerSettingsPanel({ ...props, expandedPanel: 'orders', setExpandedPanel: change });
    closed.props.children[0].props.onClick(); expect(change).toHaveBeenLastCalledWith('range');
  });

  it('exposes the expanded state, matching region IDs and rotating chevron', () => {
    const html = renderToStaticMarkup(createElement(DrawerSettingsPanel, props));
    const bodyId = html.match(/aria-controls="([^"]+)"/)?.[1];
    const triggerId = html.match(/<button[^>]* id="([^"]+)"/)?.[1];
    expect(bodyId).toBeTruthy(); expect(triggerId).toBeTruthy();
    expect(html).toContain(`id="${bodyId}"`); expect(html).toContain(`aria-labelledby="${triggerId}"`);
    expect(html).toContain('aria-expanded="true"'); expect(html).toContain('role="region"');
    expect(html).toContain('rotate-180'); expect(html).toContain('EXAMPLE-field');
    expect(html).toContain('rounded-xl border border-border/50 bg-muted/20');
    expect(html).toContain('bg-primary/20');
  });

  it('unmounts closed drawer bodies by default and retains destructive and body styles', () => {
    const closed = renderToStaticMarkup(createElement(DrawerSettingsPanel, { ...props, expandedPanel: null }));
    expect(closed).toContain('aria-expanded="false"'); expect(closed).not.toContain('EXAMPLE-field');
    expect(closed).not.toContain('rotate-180');
    const destructive = renderToStaticMarkup(createElement(DrawerSettingsPanel, { ...props, destructive: true, bodyClassName: 'space-y-2' }));
    expect(destructive).toContain('border-destructive/30 bg-destructive/5');
    expect(destructive).toContain('bg-destructive/20'); expect(destructive).toContain('px-4 pb-4 space-y-2');
  });

  it('keeps folded Grid child state mounted but removes it from focus and accessibility', () => {
    const closed = renderToStaticMarkup(createElement(DrawerSettingsPanel, { ...props, expandedPanel: null, keepMounted: true }));
    expect(closed).toContain('EXAMPLE-field'); expect(closed).toContain('aria-hidden="true"');
    expect(closed).toContain('inert=""'); expect(closed).toContain('height:0');
    const open = renderToStaticMarkup(createElement(DrawerSettingsPanel, { ...props, keepMounted: true }));
    expect(open).not.toContain('inert='); expect(open).not.toMatch(/role="region"[^>]*aria-hidden=/);
  });

  it('uses the same component in both screens and preserves the drawer default and panel IDs', () => {
    const drawer = readFileSync('client/src/components/BotManagementDrawer.tsx', 'utf8');
    const grid = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    for (const source of [drawer, grid]) expect(source).toContain("from '@/components/ui/settings-panel'");
    expect(drawer).not.toContain('function DrawerSettingsPanel');
    expect(drawer).toContain("useState<string | null>('general')");
    expect(drawer.match(/<DrawerSettingsPanel\b/g)).toHaveLength(6);
    for (const id of ["lab-source", "general", "growth", "cash", "subaccount", "danger"]) {
      expect(drawer).toMatch(new RegExp('id="' + id + '"'));
    }
    expect(drawer).not.toContain('keepMounted');
    const panel = readFileSync('client/src/components/ui/settings-panel.tsx', 'utf8');
    expect(panel).toContain('<AnimatePresence initial={false}>');
    expect(panel).toContain('transition={{ duration: 0.2 }}');
  });
});
