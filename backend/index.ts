import server, { sequelize } from './server.js';
import { PORT } from './config/config.js';
import { recoverAgentTasks } from './agent/runner.js';

recoverAgentTasks(sequelize)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Backend server is running on port ${PORT}`);
    });
  })
  .catch(async () => {
    console.error('Cannot recover Agent tasks. Check database migrations before starting the backend.');
    await sequelize.close();
    process.exitCode = 1;
  });
