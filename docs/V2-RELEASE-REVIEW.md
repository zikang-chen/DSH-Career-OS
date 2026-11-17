# v2发布审查修复

独立只读审查与纯内存复现，不读取个人DB、不替代真实GUI验收。

- 研究任务running/results从模块全局改为每个manager实例私有，避免一处dispose取消其他实例任务。
- 去重key补齐URL、读取深度、公司/岗位方向、timeout等，避免不同目标复用错误结果；只读预览cache也补limit/fillBody等。
- Today跟进日期按Asia/Shanghai本地日判断，同一UTC/+08时刻结果一致。
- Offer岗位不再作为未投新机会推荐或触发未投截止提醒。
- 列表/首页assessment不再逐行getJob加载完整聚合；sources/history批量IN查询两次。500条测试断言证据hydration只2次query；/jobs尚有每行来源展示/申请状态小查询可后续继续批量化。
- 图片自动处理循环每条写入前checkpoint，取消后不继续新资料写入；已完成写入不自动删除。

剩余：任务audit结果跨重启仅日志、非完整结果缓存；浏览器后台零闪烁未实际桌面验证；GUI操作与四宽度视觉未验证；P1-P3完整范围仍未完成。
