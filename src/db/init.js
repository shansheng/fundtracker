// 独立运行以初始化数据库：node src/db/init.js
const { init, DB_PATH } = require('./db');
(async () => {
  await init();
  console.log('数据库已初始化:', DB_PATH);
  process.exit(0);
})();
