/*
 * Ketcher 使用监测配置。
 *
 * 这个文件会在 usage-monitor.js 之前加载。
 * 以后调参数优先改这里，不要直接改监测主程序。
 * 所有时间单位都是毫秒。
 */
window.KETCHER_MONITOR_CONFIG = {
  /*
   * 是否把检测报告自动上传到 Flask 后端。
   * true：点击“完成并分析”后，报告会保存到 flask_app/data/reports。
   * false：报告只留在浏览器本地，不会自动保存到后端。
   */
  autoUpload: true,

  /*
   * 报告上传接口。
   * 使用相对路径，兼容站点部署在 /molecule-captcha/ 子路径下。
   */
  reportEndpoint: 'api/reports',

  /*
   * 检测开始接口。
   * 前端开始记录前会先向后端领取一次性会话 token；
   * 最后提交报告时必须带上这个 token，后端才会接受。
   */
  sessionEndpoint: 'api/sessions',

  limits: {
    /*
     * 单次报告最多保存多少条操作事件。
     * 数值越大，细节越完整，但 JSON 文件也越大。
     */
    maxEvents: 12000,

    /*
     * 单次报告最多保存多少段鼠标/触控轨迹。
     * 一段轨迹指从按下到松开的一次完整操作。
     */
    maxStrokes: 3000,

    /*
     * 单次报告最多保存多少个全局鼠标轨迹点。
     * 这些点用于复刻回放鼠标移动过程。
     */
    maxPointerTrail: 25000,

    /*
     * 单段拖拽轨迹内部最多保存多少个采样点。
     * 防止一次很长的拖拽让报告体积过大。
     */
    maxPointsPerStroke: 500
  },

  pointerSampling: {
    /*
     * 单段拖拽轨迹内部，两次采样之间的最小时间间隔。
     * 数值越小，轨迹越细腻，但 JSON 越大；
     * 数值越大，文件更小，但轨迹会更粗糙。
     */
    strokePointMinIntervalMs: 24,

    /*
     * 单段拖拽轨迹内部，两次采样之间的最小移动距离。
     * 时间间隔达到要求，或移动距离达到要求，都会记录一个新点。
     */
    strokePointMinDistancePx: 4,

    /*
     * 全局鼠标轨迹的最小采样时间间隔。
     * 如果你想调“鼠标轨迹记录点的时间间隔”，通常优先改这个值。
     */
    pointerTrailMinIntervalMs: 32,

    /*
     * 全局鼠标轨迹的最小采样移动距离。
     * 时间间隔达到要求，或移动距离达到要求，都会记录一个新点。
     */
    pointerTrailMinDistancePx: 4
  },

  timers: {
    /*
     * 检查分子结构是否变化的频率。
     * 数值越小，发现结构变化越及时，但浏览器开销也会略高。
     */
    structurePollIntervalMs: 200,

    /*
     * 检查 Ketcher 编辑器是否加载完成的频率。
     */
    editorReadyCheckIntervalMs: 100,

    /*
     * 左侧状态面板刷新计时器和统计数字的频率。
     */
    dockRefreshIntervalMs: 1000
  },

  attribution: {
    /*
     * 画板操作之后，如果结构变化发生在这个时间窗口内，
     * 系统会认为这次结构变化与人工操作有关。
     */
    canvasInputLinkWindowMs: 2200,

    /*
     * 工具栏或菜单点击之后，用来关联结构变化的时间窗口。
     */
    toolInputLinkWindowMs: 6500,

    /*
     * 删除、撤销、重做等纠错动作之后，用来关联后续结构变化的时间窗口。
     */
    correctionLinkWindowMs: 3500,

    /*
     * 把相邻结构变化合并成同一个编辑事务时使用的时间间隔。
     */
    editTransactionGapMs: 2500
  }
};
