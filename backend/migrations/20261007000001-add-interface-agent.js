export async function up(queryInterface, Sequelize) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.addColumn(
      'cases',
      'executionInfo',
      { type: Sequelize.JSONB, allowNull: true },
      { transaction }
    );
    await queryInterface.addColumn(
      'runs',
      'agentEnvironment',
      { type: Sequelize.JSONB, allowNull: true },
      { transaction }
    );
    await queryInterface.createTable(
      'agentTasks',
      {
        id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
        runId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'runs', key: 'id' },
          onDelete: 'CASCADE',
        },
        createdBy: {
          type: Sequelize.INTEGER,
          allowNull: true,
          references: { model: 'users', key: 'id' },
          onDelete: 'SET NULL',
        },
        state: { type: Sequelize.STRING, allowNull: false, defaultValue: 'preparing' },
        plan: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
        results: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        events: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        analysis: { type: Sequelize.TEXT, allowNull: true },
        error: { type: Sequelize.TEXT, allowNull: true },
        startedAt: { type: Sequelize.DATE, allowNull: true },
        finishedAt: { type: Sequelize.DATE, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      },
      { transaction }
    );
    await queryInterface.addIndex('agentTasks', ['runId', 'createdAt'], { transaction });
    await queryInterface.addColumn(
      'runCases',
      'executionSource',
      { type: Sequelize.STRING, allowNull: false, defaultValue: 'manual' },
      { transaction }
    );
    await queryInterface.addColumn(
      'runCases',
      'agentTaskId',
      {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'agentTasks', key: 'id' },
        onDelete: 'SET NULL',
      },
      { transaction }
    );
  });
}

export async function down(queryInterface) {
  await queryInterface.sequelize.transaction(async (transaction) => {
    await queryInterface.removeColumn('runCases', 'agentTaskId', { transaction });
    await queryInterface.removeColumn('runCases', 'executionSource', { transaction });
    await queryInterface.dropTable('agentTasks', { transaction });
    await queryInterface.removeColumn('runs', 'agentEnvironment', { transaction });
    await queryInterface.removeColumn('cases', 'executionInfo', { transaction });
  });
}
