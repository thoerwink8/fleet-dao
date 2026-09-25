// 构建时由 vite.config.ts 写进包里的配置（define），不是运行时读的环境变量。
interface ImportMetaEnv {
  /**
   * 演示版在哪（FLEET_DEMO_URL，默认 /demo/）：正式驾驶舱登录页的「看演示版」、发出去的演示链接都指向它。
   * 发布脚本按 release.env 的 FLEET_DEMO_PATH 给。
   */
  readonly FLEET_DEMO_URL?: string;
  /** 演示版：可见范围文件所在的目录，以 / 结尾（FLEET_DEMO_SCOPES，默认演示版自己目录下的 scopes/）。 */
  readonly FLEET_DEMO_SCOPES?: string;
}
