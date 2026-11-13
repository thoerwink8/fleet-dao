// 装法（#3858）：`vite build --mode desktop`（vite 不许叫 local）出的是本机装法的页面（base=/，导航换成会话、任务、待我、定时、宿主、设置），
// 其余是挂在 /next/ 下的香港那份。
export const IS_LOCAL: boolean = import.meta.env.MODE === 'desktop';
