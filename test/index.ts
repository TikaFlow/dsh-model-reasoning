// 测试入口：依次执行各模块用例并汇总退出码
import { run as runCatalog } from './catalog.test'
import { run as runConfig } from './config.test'
import { run as runMigrate } from './migrate.test'
import { summary } from './helper'

runCatalog()
runConfig()
runMigrate()
summary()
