// 主题种子表：16 条（8 套主题 × 深浅），每条只写 13 个基色。
// 校准值（状态墨色、次要文字、控件边框、聚焦圈的份量，以及按钮上的字色）不在这里写：
// 由 scripts/gen-palettes.ts 按 WCAG 阈值算出来，写进 palettes.generated.css。
// 改了这里，跑 pnpm --dir packages/web gen:palettes；palettes.test.ts 会核对「生成结果 = 提交的文件」。
// 怎么加一套主题见 docs/design/驾驶舱界面.md「怎么加一套主题」。

/** 13 个基色，全是 #rrggbb。 */
export interface Seeds {
  /** 页面底 */
  bg: string;
  /** 侧栏底 */
  panel: string;
  /** 卡片底 */
  surface: string;
  /** 浮层底 */
  elev: string;
  /** 主要文字 */
  fg: string;
  /** 品牌色：主按钮、选中导航、链接、聚焦圈 */
  brand: string;
  /** 七个状态色：只用来表达状态 */
  run: string;
  wait: string;
  human: string;
  stall: string;
  fail: string;
  done: string;
  stop: string;
}

export interface PaletteSeed {
  /** 主题 id，和 lib/theme.ts 的 PaletteId 一一对应（palettes.test.ts 核对）。 */
  id: string;
  mode: 'light' | 'dark';
  seeds: Seeds;
}

export const PALETTE_SEEDS: readonly PaletteSeed[] = [
  {
    id: 'graphite',
    mode: 'dark',
    seeds: {
      bg: '#0c0d0f',
      panel: '#0f1013',
      surface: '#15161a',
      elev: '#1c1d22',
      fg: '#ececef',
      brand: '#ececef',
      run: '#4c9aff',
      wait: '#8a91a0',
      human: '#a78bfa',
      stall: '#f2b24c',
      fail: '#ff6369',
      done: '#3fcf8e',
      stop: '#6e6f78',
    },
  },
  {
    id: 'graphite',
    mode: 'light',
    seeds: {
      bg: '#f4f4f5',
      panel: '#fafafa',
      surface: '#ffffff',
      elev: '#ffffff',
      fg: '#18181b',
      brand: '#18181b',
      run: '#1d6ff2',
      wait: '#6b7280',
      human: '#7c3aed',
      stall: '#c27803',
      fail: '#dc2f36',
      done: '#13925a',
      stop: '#a1a1aa',
    },
  },
  {
    id: 'celadon',
    mode: 'light',
    seeds: {
      bg: '#edf2ef',
      panel: '#f4f8f6',
      surface: '#fbfdfc',
      elev: '#ffffff',
      fg: '#15241f',
      brand: '#2f8a70',
      run: '#2767d6',
      wait: '#6b7d76',
      human: '#7b4fd0',
      stall: '#b87712',
      fail: '#c8413b',
      done: '#22894a',
      stop: '#9aaba4',
    },
  },
  {
    id: 'celadon',
    mode: 'dark',
    seeds: {
      bg: '#0b1311',
      panel: '#0f1816',
      surface: '#131f1c',
      elev: '#1a2824',
      fg: '#e2ede8',
      brand: '#6fc9ad',
      run: '#5ea3ff',
      wait: '#7d938b',
      human: '#b597ff',
      stall: '#eab45c',
      fail: '#ff7b72',
      done: '#56d08a',
      stop: '#5c6d67',
    },
  },
  {
    id: 'nord',
    mode: 'dark',
    seeds: {
      bg: '#2e3440',
      panel: '#292e39',
      surface: '#353c4a',
      elev: '#3f4758',
      fg: '#eceff4',
      brand: '#88c0d0',
      run: '#81a1c1',
      wait: '#8591a8',
      human: '#b48ead',
      stall: '#ebcb8b',
      fail: '#d0747c',
      done: '#a3be8c',
      stop: '#616e88',
    },
  },
  {
    id: 'nord',
    mode: 'light',
    seeds: {
      bg: '#e5e9f0',
      panel: '#eceff4',
      surface: '#f8f9fb',
      elev: '#ffffff',
      fg: '#2e3440',
      brand: '#5e81ac',
      run: '#4c78a8',
      wait: '#6b7689',
      human: '#93678c',
      stall: '#b38622',
      fail: '#b04a55',
      done: '#6a8c4f',
      stop: '#9aa3b5',
    },
  },
  {
    id: 'tokyo',
    mode: 'dark',
    seeds: {
      bg: '#1a1b26',
      panel: '#16161e',
      surface: '#1f2335',
      elev: '#262b40',
      fg: '#c8d1f7',
      brand: '#7aa2f7',
      run: '#7dcfff',
      wait: '#7780a8',
      human: '#bb9af7',
      stall: '#e0af68',
      fail: '#f7768e',
      done: '#9ece6a',
      stop: '#545c7e',
    },
  },
  {
    id: 'tokyo',
    mode: 'light',
    seeds: {
      bg: '#e1e2e7',
      panel: '#e9e9ed',
      surface: '#f4f4f7',
      elev: '#ffffff',
      fg: '#343b58',
      brand: '#2e7de9',
      run: '#007197',
      wait: '#6172b0',
      human: '#9854f1',
      stall: '#8f5e15',
      fail: '#e5215b',
      done: '#587539',
      stop: '#a1a6c5',
    },
  },
  {
    id: 'dracula',
    mode: 'dark',
    seeds: {
      bg: '#282a36',
      panel: '#21222c',
      surface: '#2f3141',
      elev: '#383a4c',
      fg: '#f8f8f2',
      brand: '#bd93f9',
      run: '#8be9fd',
      wait: '#7c86b3',
      human: '#ff79c6',
      stall: '#ffb86c',
      fail: '#ff5555',
      done: '#50fa7b',
      stop: '#6b6f86',
    },
  },
  {
    id: 'dracula',
    mode: 'light',
    seeds: {
      bg: '#f5f1e1',
      panel: '#faf7ea',
      surface: '#fffdf5',
      elev: '#ffffff',
      fg: '#1f1f1f',
      brand: '#644ac9',
      run: '#036a96',
      wait: '#635d97',
      human: '#a3144d',
      stall: '#a34d14',
      fail: '#cb3a2a',
      done: '#14710a',
      stop: '#a8a497',
    },
  },
  {
    id: 'one',
    mode: 'dark',
    seeds: {
      bg: '#282c34',
      panel: '#21252b',
      surface: '#2c313a',
      elev: '#353b45',
      fg: '#d7dae0',
      brand: '#61afef',
      run: '#56b6c2',
      wait: '#7f848e',
      human: '#c678dd',
      stall: '#e5c07b',
      fail: '#e06c75',
      done: '#98c379',
      stop: '#5c6370',
    },
  },
  {
    id: 'one',
    mode: 'light',
    seeds: {
      bg: '#f0f0f1',
      panel: '#f7f7f8',
      surface: '#fcfcfc',
      elev: '#ffffff',
      fg: '#383a42',
      brand: '#4078f2',
      run: '#0184bc',
      wait: '#8e8f96',
      human: '#a626a4',
      stall: '#b07800',
      fail: '#e45649',
      done: '#50a14f',
      stop: '#b0b1b6',
    },
  },
  {
    id: 'solarized',
    mode: 'light',
    seeds: {
      bg: '#fdf6e3',
      panel: '#f5eed9',
      surface: '#fffbf0',
      elev: '#fffcf4',
      fg: '#073642',
      brand: '#268bd2',
      run: '#2aa198',
      wait: '#7f9194',
      human: '#6c71c4',
      stall: '#b58900',
      fail: '#dc322f',
      done: '#859900',
      stop: '#a3aba6',
    },
  },
  {
    id: 'solarized',
    mode: 'dark',
    seeds: {
      bg: '#002b36',
      panel: '#01252f',
      surface: '#073642',
      elev: '#0b3f4c',
      fg: '#e4ddc8',
      brand: '#3d9ee0',
      run: '#2aa198',
      wait: '#839496',
      human: '#8b8fe0',
      stall: '#d2a21a',
      fail: '#f0524f',
      done: '#9fb81a',
      stop: '#586e75',
    },
  },
  {
    id: 'darcula',
    mode: 'dark',
    seeds: {
      bg: '#2b2b2b',
      panel: '#313335',
      surface: '#353739',
      elev: '#3c3f41',
      fg: '#d0d4d9',
      brand: '#cc7832',
      run: '#6897bb',
      wait: '#8c8c8c',
      human: '#a887bd',
      stall: '#c9c238',
      fail: '#ff6b68',
      done: '#7ea56a',
      stop: '#606366',
    },
  },
  {
    id: 'darcula',
    mode: 'light',
    seeds: {
      bg: '#f2f2f2',
      panel: '#f7f8fa',
      surface: '#ffffff',
      elev: '#ffffff',
      fg: '#1e1f22',
      brand: '#c35b12',
      run: '#3574f0',
      wait: '#818594',
      human: '#871094',
      stall: '#9e7a00',
      fail: '#db3b4b',
      done: '#208a3c',
      stop: '#a8adbd',
    },
  },
];
