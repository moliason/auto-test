export default function defineAgentTask(sequelize, DataTypes) {
  return sequelize.define(
    'AgentTask',
    {
      runId: { type: DataTypes.INTEGER, allowNull: false },
      createdBy: { type: DataTypes.INTEGER, allowNull: true },
      state: { type: DataTypes.STRING, allowNull: false, defaultValue: 'preparing' },
      plan: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      results: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      events: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      analysis: { type: DataTypes.TEXT, allowNull: true },
      error: { type: DataTypes.TEXT, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true },
    },
    { tableName: 'agentTasks' }
  );
}
