export async function up(queryInterface, Sequelize) {
  await queryInterface.addColumn('agentTasks', 'version', {
    type: Sequelize.INTEGER,
    allowNull: false,
    defaultValue: 1,
  });
  await queryInterface.addIndex('agentTasks', ['runId'], {
    name: 'agentTasks_one_running_per_run',
    unique: true,
    where: { state: 'running' },
  });
}

export async function down(queryInterface) {
  await queryInterface.removeIndex('agentTasks', 'agentTasks_one_running_per_run');
  await queryInterface.removeColumn('agentTasks', 'version');
}
