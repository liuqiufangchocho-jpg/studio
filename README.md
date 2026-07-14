门户网站数据统计 V4

上传结构必须保持：
/index.html
/js/supabase-config.js
/js/task-system.js

不要只上传 index.html，否则数据统计模块无法连接任务系统。

本版新增：
1. 任务状态：进行中、已关闭、已过期。
2. 可通过统计页面关闭或重新开放任务。
3. 显示截止日期。
4. 排序：班级姓名、姓名、完成状态、最高分、完成时间。
5. 导出 CSV；保留导出 Excel。
6. 完成率颜色：0–49% 红色、50–79% 橙色、80–100% 绿色。
7. 不加入打印功能。

上线前必须先在 Supabase SQL Editor 运行：
supabase_task_status_deadline_migration_v1.sql
