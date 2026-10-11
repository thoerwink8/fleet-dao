// 右侧抽屉是不是浮在画布上打开着（单 #1819）。画布据此在抽屉盖住选中卡片时平移避开；停靠的抽屉不盖画布，不算。
import { createContext } from 'react';

export const DrawerFloatingContext = createContext(false);
