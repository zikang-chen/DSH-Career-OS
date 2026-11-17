// One object that owns all repositories, so tools and routes share a single
// database handle and a single logging path.
import { ProfileRepo } from './profile.js'
import { JobRepo } from './jobs.js'
import { ApplicationRepo } from './applications.js'
import { IntelRepo } from './intel.js'
import { MonitorRepo } from './monitor.js'
import { CaptureRepo } from './captures.js'
import { KnowledgeRepo } from './knowledge.js'

export class Repos {
  constructor(db, logger) {
    this.db = db
    this.log = logger
    this.profile = new ProfileRepo(db, logger)
    this.jobs = new JobRepo(db, logger)
    this.applications = new ApplicationRepo(db, logger)
    this.intel = new IntelRepo(db, logger, this.jobs)
    this.monitor = new MonitorRepo(db, logger)
    this.captures = new CaptureRepo(db, logger)
    this.knowledge = new KnowledgeRepo(db, logger)
  }
}

export { ProfileRepo, JobRepo, ApplicationRepo, IntelRepo, MonitorRepo, CaptureRepo, KnowledgeRepo }
